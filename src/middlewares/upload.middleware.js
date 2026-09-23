import multer from 'multer';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { ApiError } from '../utils/ApiError.js';
import { HTTP_STATUS } from '../constants/index.js';

// Allowed image MIME types
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/jpg',
  'image/gif',
  'image/heic',
  'image/heif'
];

// Memory storage keeps the buffer in RAM so sharp can optimize before saving to disk
const memoryStorage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype.toLowerCase())) {
    cb(null, true);
  } else {
    cb(
      new ApiError(
        HTTP_STATUS.BAD_REQUEST,
        'Invalid file type. Only JPEG, PNG, WebP, JPG, and GIF images are allowed.'
      ),
      false
    );
  }
};

const multerInstance = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB input limit before compression
  },
  fileFilter
});

/**
 * Ensure the target directory exists under uploads/<folderPath>
 */
const ensureUploadDir = (folderPath) => {
  const sanitizedFolder = folderPath.replace(/^(\.\.(\/|\\|$))+/, '');
  const dirPath = path.join(process.cwd(), 'uploads', sanitizedFolder);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return { dirPath, sanitizedFolder };
};

/**
 * Generate a standardized filename containing the User ID
 */
const generateFilename = (userId, fieldName, index = null) => {
  const cleanUserId = userId ? userId.toString().replace(/[^a-zA-Z0-9_-]/g, '') : 'guest';
  const cleanField = fieldName ? fieldName.replace(/[^a-zA-Z0-9_-]/g, '') : 'photo';
  const timestamp = Date.now();
  const random = Math.round(Math.random() * 1e6);
  const idxStr = index !== null ? `-${index}` : '';
  return `${cleanUserId}-${cleanField}${idxStr}-${timestamp}-${random}.webp`;
};

/**
 * Optimize an image buffer with sharp and write to disk as .webp
 */
const processAndSaveImage = async (buffer, outputFilePath, options = {}) => {
  const { maxWidth = 1920, maxHeight = 1920, quality = 80 } = options;

  return await sharp(buffer)
    .rotate() // Automatically orient based on EXIF
    .resize({
      width: maxWidth,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp({ quality, effort: 4 })
    .toFile(outputFilePath);
};

/**
 * Helper to safely parse stringified JSON in FormData req.body
 */
const parseFormDataJsonFields = (body) => {
  if (!body || typeof body !== 'object') return;
  const jsonFields = [
    'birthday',
    'interestedIn',
    'interests',
    'photos',
    'existingPhotos',
    'location',
    'partnerPreferences'
  ];

  for (const field of jsonFields) {
    if (typeof body[field] === 'string') {
      const trimmed = body[field].trim();
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        try {
          body[field] = JSON.parse(trimmed);
        } catch {
          // Keep as raw string if JSON.parse fails
        }
      }
    }
  }

  // Handle boolean strings
  if (body.showGenderOnProfile !== undefined && typeof body.showGenderOnProfile === 'string') {
    body.showGenderOnProfile = body.showGenderOnProfile === 'true';
  }
};

/**
 * Middleware: Upload & Optimize a single image
 * @param {string} folderPath - Target subfolder (e.g., 'face-verification', 'photos')
 * @param {string} [fieldName='image'] - Form field name
 * @param {Object} [options={}] - Optimization options (maxWidth, maxHeight, quality)
 */
export const uploadSingleImage = (folderPath, fieldName = 'image', options = {}) => {
  const uploadHandler = multerInstance.any();

  return async (req, res, next) => {
    uploadHandler(req, res, async (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return next(new ApiError(HTTP_STATUS.BAD_REQUEST, 'File size too large. Maximum 15MB allowed.'));
          }
          return next(new ApiError(HTTP_STATUS.BAD_REQUEST, err.message));
        }
        return next(err);
      }

      parseFormDataJsonFields(req.body);

      const files = Array.isArray(req.files) ? req.files : [];
      const uploadedFile = files[0] || req.file;

      if (!uploadedFile) {
        return next();
      }

      try {
        const { dirPath, sanitizedFolder } = ensureUploadDir(folderPath);
        const userId = req.user?._id || req.body?.userId || 'user';
        const filename = generateFilename(userId, fieldName);
        const outputPath = path.join(dirPath, filename);

        const info = await processAndSaveImage(uploadedFile.buffer, outputPath, options);

        // Standardize file info on req.file
        req.file = {
          fieldname: uploadedFile.fieldname,
          originalname: uploadedFile.originalname,
          encoding: uploadedFile.encoding,
          mimetype: 'image/webp',
          size: info.size,
          width: info.width,
          height: info.height,
          filename: filename,
          path: outputPath,
          destination: dirPath,
          fileUrl: `/uploads/${sanitizedFolder}/${filename}`
        };

        next();
      } catch (sharpErr) {
        return next(new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, `Image optimization failed: ${sharpErr.message}`));
      }
    });
  };
};

/**
 * Middleware: Upload & Optimize multiple images
 * @param {string} folderPath - Target subfolder (e.g., 'photos', 'profiles')
 * @param {string} [fieldName='photos'] - Form field name
 * @param {number} [maxCount=6] - Maximum number of files allowed
 * @param {Object} [options={}] - Optimization options
 */
export const uploadMultipleImages = (folderPath, fieldName = 'photos', maxCount = 6, options = {}) => {
  const uploadHandler = multerInstance.any();

  return async (req, res, next) => {
    uploadHandler(req, res, async (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return next(new ApiError(HTTP_STATUS.BAD_REQUEST, 'One or more files exceed the 15MB size limit.'));
          }
          return next(new ApiError(HTTP_STATUS.BAD_REQUEST, err.message));
        }
        return next(err);
      }

      parseFormDataJsonFields(req.body);

      const files = Array.isArray(req.files) ? req.files : [];

      if (!files || files.length === 0) {
        req.files = [];
        return next();
      }

      // Deduplicate identical files
      const uniqueFiles = [];
      const seenSignatures = new Set();
      for (const file of files) {
        const sample = file.buffer ? file.buffer.slice(0, 100).toString('hex') : file.originalname;
        const sig = `${file.size}-${sample}`;
        if (!seenSignatures.has(sig)) {
          seenSignatures.add(sig);
          uniqueFiles.push(file);
        }
      }

      if (uniqueFiles.length > maxCount) {
        return next(
          new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `Cannot upload more than ${maxCount} images at once.`
          )
        );
      }

      try {
        const { dirPath, sanitizedFolder } = ensureUploadDir(folderPath);
        const userId = req.user?._id || req.body?.userId || 'user';

        const processedFiles = await Promise.all(
          uniqueFiles.map(async (file, index) => {
            const filename = generateFilename(userId, fieldName, index);
            const outputPath = path.join(dirPath, filename);

            const info = await processAndSaveImage(file.buffer, outputPath, options);

            return {
              fieldname: file.fieldname,
              originalname: file.originalname,
              encoding: file.encoding,
              mimetype: 'image/webp',
              size: info.size,
              width: info.width,
              height: info.height,
              filename: filename,
              path: outputPath,
              destination: dirPath,
              fileUrl: `/uploads/${sanitizedFolder}/${filename}`
            };
          })
        );

        req.files = processedFiles;
        req.file = processedFiles[0];
        next();
      } catch (sharpErr) {
        return next(new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, `Image optimization failed: ${sharpErr.message}`));
      }
    });
  };
};

/**
 * Middleware: Flexible Profile & Media Uploader (Preserves exact arrival sequence for mixed binary files & existing URLs)
 * @param {string} [folderPath='profiles'] - Target subfolder
 * @param {number} [maxPhotos=6] - Max photos count
 * @param {Object} [options={}] - Sharp optimization options
 */
export const uploadProfileMedia = (folderPath = 'profiles', maxPhotos = 6, options = {}) => {
  return async (req, res, next) => {
    const contentType = req.headers['content-type'] || '';

    // If request is not multipart/form-data, standard body parser handles it
    if (!contentType.includes('multipart/form-data')) {
      if (req.body) {
        parseFormDataJsonFields(req.body);
      }
      return next();
    }

    let busboyInstance;
    try {
      busboyInstance = (await import('busboy')).default({
        headers: req.headers,
        limits: {
          fileSize: 15 * 1024 * 1024, // 15MB per file
          files: maxPhotos
        }
      });
    } catch (importErr) {
      return next(new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Failed to initialize multipart parser'));
    }

    const body = {};
    const orderedPhotosPromises = [];
    const filePromises = [];
    let fileCount = 0;
    let hasError = false;
    let photoIndexCounter = 0;

    const emitError = (err) => {
      if (hasError) return;
      hasError = true;
      next(err);
    };

    // Capture text fields
    busboyInstance.on('field', (name, val) => {
      if (hasError) return;

      const isPhotoField =
        name === 'photos' ||
        name === 'photos[]' ||
        name === 'images' ||
        name === 'images[]' ||
        name === 'existingPhotos' ||
        name === 'existingPhotos[]';

      if (isPhotoField && val) {
        const trimmed = typeof val === 'string' ? val.trim() : '';
        if (
          (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
          (trimmed.startsWith('{') && trimmed.endsWith('}'))
        ) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (typeof item === 'string') {
                  orderedPhotosPromises.push(Promise.resolve({ type: 'existing', url: item }));
                } else if (item && (item.url || item.fileUrl)) {
                  orderedPhotosPromises.push(
                    Promise.resolve({
                      type: 'existing',
                      url: item.url || item.fileUrl,
                      isPrimary: item.isPrimary
                    })
                  );
                }
              }
            } else if (parsed && (parsed.url || parsed.fileUrl)) {
              orderedPhotosPromises.push(
                Promise.resolve({
                  type: 'existing',
                  url: parsed.url || parsed.fileUrl,
                  isPrimary: parsed.isPrimary
                })
              );
            }
          } catch {
            if (trimmed) {
              orderedPhotosPromises.push(Promise.resolve({ type: 'existing', url: trimmed }));
            }
          }
        } else if (trimmed) {
          orderedPhotosPromises.push(Promise.resolve({ type: 'existing', url: trimmed }));
        }
      }

      // Store in req.body
      if (body[name] === undefined) {
        body[name] = val;
      } else if (Array.isArray(body[name])) {
        body[name].push(val);
      } else {
        body[name] = [body[name], val];
      }
    });

    // Capture file streams
    busboyInstance.on('file', (name, fileStream, info) => {
      if (hasError) {
        fileStream.resume();
        return;
      }

      fileCount++;
      if (fileCount > maxPhotos) {
        fileStream.resume();
        return emitError(
          new ApiError(HTTP_STATUS.BAD_REQUEST, `Too many files uploaded. Maximum ${maxPhotos} allowed.`)
        );
      }

      const { filename: originalFilename, mimeType } = info;
      if (mimeType && !ALLOWED_MIME_TYPES.includes(mimeType.toLowerCase())) {
        fileStream.resume();
        return emitError(
          new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'Invalid file type. Only JPEG, PNG, WebP, JPG, and GIF images are allowed.'
          )
        );
      }

      const chunks = [];
      let fileSize = 0;
      let limitExceeded = false;

      fileStream.on('data', (chunk) => {
        fileSize += chunk.length;
        chunks.push(chunk);
      });

      fileStream.on('limit', () => {
        limitExceeded = true;
      });

      const currentIdx = photoIndexCounter++;

      const processPromise = new Promise((resolve, reject) => {
        fileStream.on('error', (err) => reject(err));
        fileStream.on('end', async () => {
          if (limitExceeded) {
            return reject(
              new ApiError(HTTP_STATUS.BAD_REQUEST, 'One or more files exceed the 15MB size limit.')
            );
          }
          const buffer = Buffer.concat(chunks);
          if (buffer.length === 0) {
            return resolve(null);
          }

          try {
            const { dirPath, sanitizedFolder } = ensureUploadDir(folderPath);
            const userId = req.user?._id || body?.userId || 'user';
            const filename = generateFilename(userId, 'photos', currentIdx);
            const outputPath = path.join(dirPath, filename);

            const sharpInfo = await processAndSaveImage(buffer, outputPath, options);

            const fileObj = {
              fieldname: name,
              originalname: originalFilename || filename,
              mimetype: 'image/webp',
              size: sharpInfo.size,
              width: sharpInfo.width,
              height: sharpInfo.height,
              filename: filename,
              path: outputPath,
              destination: dirPath,
              fileUrl: `/uploads/${sanitizedFolder}/${filename}`
            };

            resolve({
              type: 'uploaded',
              fileUrl: fileObj.fileUrl,
              fileObj
            });
          } catch (sharpErr) {
            reject(
              new ApiError(
                HTTP_STATUS.INTERNAL_SERVER_ERROR,
                `Image optimization failed: ${sharpErr.message}`
              )
            );
          }
        });
      });

      const isPhotoField =
        name === 'photos' ||
        name === 'photos[]' ||
        name === 'images' ||
        name === 'images[]' ||
        name === 'image';

      if (isPhotoField) {
        orderedPhotosPromises.push(processPromise);
      }
      filePromises.push(processPromise);
    });

    busboyInstance.on('error', (err) => {
      emitError(new ApiError(HTTP_STATUS.BAD_REQUEST, `Multipart parsing error: ${err.message}`));
    });

    busboyInstance.on('close', async () => {
      if (hasError) return;

      try {
        const [orderedResults, fileResults] = await Promise.all([
          Promise.all(orderedPhotosPromises),
          Promise.all(filePromises)
        ]);

        const validFiles = fileResults.filter(Boolean).map((r) => r.fileObj);
        const validOrderedPhotos = orderedResults.filter(Boolean);

        parseFormDataJsonFields(body);

        req.body = body;
        req.files = validFiles;
        req.file = validFiles[0] || null;
        req.orderedPhotos = validOrderedPhotos;

        next();
      } catch (err) {
        emitError(err);
      }
    });

    req.pipe(busboyInstance);
  };
};

/**
 * Safely delete an uploaded file from disk by relative URL or file path
 * @param {string} fileUrlOrPath - e.g. '/uploads/face-verification/userId-123.webp' or 'uploads/...'
 * @returns {Promise<boolean>} - true if deleted or didn't exist, false on failure
 */
export const deleteUploadedFile = async (fileUrlOrPath) => {
  if (!fileUrlOrPath || typeof fileUrlOrPath !== 'string') return false;

  try {
    // Strip leading slashes, backslashes, and query params
    const cleanUrl = fileUrlOrPath.split('?')[0].replace(/^[\/\\]+/, '');
    const isWindowsAbsolutePath = /^[a-zA-Z]:[\\/]/.test(fileUrlOrPath);
    const fullPath = isWindowsAbsolutePath
      ? fileUrlOrPath
      : path.join(process.cwd(), cleanUrl);

    if (fs.existsSync(fullPath)) {
      await fs.promises.unlink(fullPath);
      return true;
    }
    return false;
  } catch (error) {
    console.warn(`[deleteUploadedFile] Failed to delete file at ${fileUrlOrPath}:`, error.message);
    return false;
  }
};

/**
 * Safely delete multiple uploaded files
 * @param {string[]} fileUrlsOrPaths
 */
export const deleteUploadedFiles = async (fileUrlsOrPaths = []) => {
  if (!Array.isArray(fileUrlsOrPaths) || fileUrlsOrPaths.length === 0) return;
  await Promise.allSettled(fileUrlsOrPaths.map((item) => deleteUploadedFile(item)));
};

/**
 * Format relative public URL for an uploaded file
 */
export const formatUploadedUrl = (folderPath, filename) => {
  const sanitizedFolder = folderPath.replace(/^(\.\.(\/|\\|$))+/, '');
  return `/uploads/${sanitizedFolder}/${filename}`;
};

// Default export backward compatibility
export const upload = multerInstance;

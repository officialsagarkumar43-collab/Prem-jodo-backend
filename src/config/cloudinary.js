import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';
import { ENV } from './env.js';

// Configure Cloudinary SDK
cloudinary.config({
  cloud_name: (ENV.CLOUDINARY_CLOUD_NAME || '').trim(),
  api_key: (ENV.CLOUDINARY_API_KEY || '').trim(),
  api_secret: (ENV.CLOUDINARY_API_SECRET || '').trim(),
  secure: true
});

/**
 * Check if Cloudinary credentials are validly configured
 */
export const isCloudinaryConfigured = () => {
  const name = ENV.CLOUDINARY_CLOUD_NAME;
  const key = ENV.CLOUDINARY_API_KEY;
  const secret = ENV.CLOUDINARY_API_SECRET;
  return Boolean(
    name &&
    key &&
    secret &&
    !name.includes('your_cloud_name') &&
    !key.includes('your_api_key')
  );
};

/**
 * Upload an image Buffer to Cloudinary
 * @param {Buffer} buffer - Image buffer (preferably pre-optimized)
 * @param {Object} [options={}] - Cloudinary upload options (folder, public_id, etc.)
 * @returns {Promise<import('cloudinary').UploadApiResponse>}
 */
export const uploadBufferToCloudinary = (buffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: options.folder || 'premjodo',
      resource_type: 'image',
      format: options.format || 'webp',
      ...options
    };

    if (options.public_id) {
      uploadOptions.public_id = options.public_id;
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          return reject(error);
        }
        resolve(result);
      }
    );

    Readable.from(buffer).pipe(uploadStream);
  });
};

/**
 * Delete a media asset from Cloudinary given its public_id or full secure URL
 * @param {string} publicIdOrUrl - Cloudinary public_id or https://res.cloudinary.com/... URL
 * @returns {Promise<boolean>}
 */
export const deleteFromCloudinary = async (publicIdOrUrl) => {
  if (!publicIdOrUrl || typeof publicIdOrUrl !== 'string') return false;

  try {
    let publicId = publicIdOrUrl;

    // If a full Cloudinary URL is passed
    if (publicIdOrUrl.includes('cloudinary.com')) {
      const match = publicIdOrUrl.match(/\/upload\/(?:v\d+\/)?([^\.]+)/);
      if (match && match[1]) {
        publicId = decodeURIComponent(match[1]);
      }
    }

    const result = await cloudinary.uploader.destroy(publicId);
    return result.result === 'ok' || result.result === 'not found';
  } catch (error) {
    console.warn(`[deleteFromCloudinary] Error deleting asset ${publicIdOrUrl}:`, error.message);
    return false;
  }
};

export { cloudinary };
export default cloudinary;

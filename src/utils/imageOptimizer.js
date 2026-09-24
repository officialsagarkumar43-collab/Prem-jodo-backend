import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

/**
 * Standard preset profiles for image optimization
 */
export const IMAGE_PRESETS = {
  PROFILE: {
    maxWidth: 1080,
    maxHeight: 1080,
    quality: 80,
    format: 'webp'
  },
  AVATAR: {
    maxWidth: 500,
    maxHeight: 500,
    quality: 80,
    format: 'webp'
  },
  THUMBNAIL: {
    maxWidth: 300,
    maxHeight: 300,
    quality: 75,
    format: 'webp'
  },
  FACE_VERIFICATION: {
    maxWidth: 1280,
    maxHeight: 1280,
    quality: 85,
    format: 'webp'
  },
  STANDARD: {
    maxWidth: 1920,
    maxHeight: 1920,
    quality: 80,
    format: 'webp'
  },
  HD: {
    maxWidth: 2560,
    maxHeight: 2560,
    quality: 85,
    format: 'webp'
  }
};

/**
 * Universal Image Optimizer Function
 *
 * @param {Buffer|string|ReadableStream} input - Image buffer, file path, or stream
 * @param {Object} [options={}] - Custom configuration or preset overrides
 * @param {string} [options.preset] - One of IMAGE_PRESETS keys ('PROFILE', 'AVATAR', 'THUMBNAIL', 'FACE_VERIFICATION', 'STANDARD', 'HD')
 * @param {number} [options.maxWidth=1920] - Max width in pixels
 * @param {number} [options.maxHeight=1920] - Max height in pixels
 * @param {number} [options.width] - Exact width (if fit is 'cover' or forced)
 * @param {number} [options.height] - Exact height
 * @param {string} [options.fit='inside'] - Resize fit strategy ('inside', 'cover', 'contain', 'fill')
 * @param {boolean} [options.withoutEnlargement=true] - Prevent upscaling smaller images
 * @param {string} [options.format='webp'] - Output format ('webp', 'jpeg', 'jpg', 'png', 'avif')
 * @param {number} [options.quality=80] - Compression quality (1-100)
 * @param {number} [options.effort=4] - CPU effort for compression (0-6)
 * @param {boolean} [options.autoRotate=true] - Auto-rotate based on EXIF orientation
 * @param {string} [options.outputPath] - Destination file path (if saving to disk directly)
 * @param {string} [options.outputFilePath] - Alias for outputPath
 *
 * @returns {Promise<{
 *   buffer?: Buffer,
 *   outputPath?: string,
 *   size: number,
 *   width: number,
 *   height: number,
 *   format: string
 * }>}
 */
export const imageOptimizer = async (input, options = {}) => {
  if (!input) {
    throw new Error('Image optimizer requires a valid image input (Buffer, file path, or stream).');
  }

  // If a preset is specified, merge it with defaults and explicit overrides
  const presetConfig = options.preset && IMAGE_PRESETS[options.preset.toUpperCase()]
    ? IMAGE_PRESETS[options.preset.toUpperCase()]
    : {};

  const config = {
    maxWidth: 1920,
    maxHeight: 1920,
    quality: 80,
    effort: 4,
    format: 'webp',
    fit: 'inside',
    withoutEnlargement: true,
    autoRotate: true,
    ...presetConfig,
    ...options
  };

  // Initialize sharp instance
  let pipeline = sharp(input);

  // Auto-rotate according to EXIF metadata
  if (config.autoRotate) {
    pipeline = pipeline.rotate();
  }

  // Configure resize
  const resizeOptions = {
    fit: config.fit,
    withoutEnlargement: config.withoutEnlargement
  };

  if (config.width || config.height) {
    if (config.width) resizeOptions.width = config.width;
    if (config.height) resizeOptions.height = config.height;
  } else {
    resizeOptions.width = config.maxWidth;
    resizeOptions.height = config.maxHeight;
  }

  pipeline = pipeline.resize(resizeOptions);

  // Configure format and compression
  const normalizedFormat = (config.format || 'webp').toLowerCase();
  switch (normalizedFormat) {
    case 'webp':
      pipeline = pipeline.webp({
        quality: config.quality,
        effort: config.effort
      });
      break;
    case 'jpeg':
    case 'jpg':
      pipeline = pipeline.jpeg({
        quality: config.quality,
        mozjpeg: true
      });
      break;
    case 'png':
      pipeline = pipeline.png({
        quality: config.quality,
        compressionLevel: 9
      });
      break;
    case 'avif':
      pipeline = pipeline.avif({
        quality: config.quality,
        effort: config.effort
      });
      break;
    default:
      pipeline = pipeline.webp({
        quality: config.quality,
        effort: config.effort
      });
      break;
  }

  const destinationPath = config.outputPath || config.outputFilePath;

  // Case 1: Write directly to file
  if (destinationPath) {
    const targetDir = path.dirname(destinationPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const info = await pipeline.toFile(destinationPath);
    return {
      outputPath: destinationPath,
      size: info.size,
      width: info.width,
      height: info.height,
      format: info.format
    };
  }

  // Case 2: Return optimized buffer and metadata
  const { data: buffer, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    buffer,
    size: info.size,
    width: info.width,
    height: info.height,
    format: info.format
  };
};

/**
 * Helper to get metadata (dimensions, format, channels, EXIF) of an image
 *
 * @param {Buffer|string} input - Image buffer or file path
 * @returns {Promise<sharp.Metadata>}
 */
export const getImageMetadata = async (input) => {
  return await sharp(input).metadata();
};

/**
 * Alias export for flexible naming
 */
export const optimizeImage = imageOptimizer;

export default imageOptimizer;

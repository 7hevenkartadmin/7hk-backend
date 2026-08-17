import multer from 'multer';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/utils/AppError.js';

const allowedImageTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/avif']);
const maxImageBytes = env.CLOUDINARY_MAX_IMAGE_MB * 1024 * 1024;

function hasValidSignature(file) {
  const bytes = file.buffer;
  if (!bytes || bytes.length < 12) return false;
  if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mimetype === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (file.mimetype === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (file.mimetype === 'image/avif') {
    const header = bytes.toString('ascii', 4, Math.min(bytes.length, 32));
    return header.startsWith('ftyp') && /avif|avis/.test(header);
  }
  return false;
}

const uploadSingleImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxImageBytes, files: 1, fields: 2 },
  fileFilter(_req, file, callback) {
    if (!allowedImageTypes.has(file.mimetype)) {
      callback(new AppError('Upload a JPG, PNG, WebP or AVIF image', 422, 'INVALID_IMAGE_TYPE'));
      return;
    }
    callback(null, true);
  },
}).single('image');

export function catalogImageUpload(req, res, next) {
  uploadSingleImage(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      return next(new AppError(
        error.code === 'LIMIT_FILE_SIZE'
          ? `Image must be ${env.CLOUDINARY_MAX_IMAGE_MB} MB or smaller`
          : 'Invalid image upload',
        422,
        'INVALID_IMAGE_UPLOAD',
      ));
    }
    if (error) return next(error);
    if (req.file && !hasValidSignature(req.file)) {
      return next(new AppError('Image content does not match its file type', 422, 'INVALID_IMAGE_CONTENT'));
    }
    return next();
  });
}

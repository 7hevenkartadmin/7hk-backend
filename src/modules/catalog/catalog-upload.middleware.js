import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { AppError } from '../../shared/utils/AppError.js';

export const catalogUploadRoot = path.resolve('uploads', 'catalog');
fs.mkdirSync(catalogUploadRoot, { recursive: true });

const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const extensionByMime = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

const storage = multer.diskStorage({
  destination: catalogUploadRoot,
  filename(_req, file, callback) {
    callback(null, `${Date.now()}-${randomUUID()}${extensionByMime[file.mimetype]}`);
  },
});

const uploadSingleImage = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
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
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      return next(new AppError(
        error.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5 MB or smaller' : 'Invalid image upload',
        422,
        'INVALID_IMAGE_UPLOAD',
      ));
    }
    return next(error);
  });
}

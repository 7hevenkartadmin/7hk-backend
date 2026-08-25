import { v2 as cloudinary } from 'cloudinary';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/utils/AppError.js';

const uploadKinds = new Set(['product', 'gallery', 'variant', 'category', 'banner', 'coupon', 'support-proof']);
const configured = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

if (configured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
    timeout: 30_000,
  });
}

function deliveryUrl(publicId, transformation) {
  return cloudinary.url(publicId, {
    secure: true,
    resource_type: 'image',
    transformation: [{ fetch_format: 'auto', quality: 'auto:good', ...transformation }],
  });
}

function uploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

export async function uploadCatalogImage(file, { kind = 'product', actorId } = {}) {
  if (!configured) {
    throw new AppError('Cloudinary image storage is not configured', 503, 'IMAGE_STORAGE_NOT_CONFIGURED');
  }
  if (!uploadKinds.has(kind)) {
    throw new AppError('Invalid image purpose', 422, 'INVALID_IMAGE_KIND');
  }

  let result;
  try {
    result = await uploadBuffer(file.buffer, {
      resource_type: 'image',
      folder: `${env.CLOUDINARY_FOLDER}/${kind}`,
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'avif'],
      unique_filename: true,
      overwrite: false,
      use_filename: false,
      tags: ['7heven', kind === 'support-proof' ? 'customer-upload' : 'admin-upload', kind],
      context: actorId ? { uploaded_by: String(actorId), purpose: kind } : { purpose: kind },
    });
  } catch {
    throw new AppError('Image storage could not process this upload', 502, 'IMAGE_UPLOAD_FAILED');
  }

  if (result.width < 64 || result.height < 64 || result.width > 8000 || result.height > 8000) {
    await cloudinary.uploader.destroy(result.public_id, { resource_type: 'image', invalidate: true }).catch(() => {});
    throw new AppError('Image dimensions must be between 64 and 8000 pixels', 422, 'INVALID_IMAGE_DIMENSIONS');
  }

  return {
    url: result.secure_url,
    publicId: result.public_id,
    width: result.width,
    height: result.height,
    format: result.format,
    bytes: result.bytes,
    variants: {
      thumbnail: deliveryUrl(result.public_id, { width: 240, height: 240, crop: 'limit' }),
      card: deliveryUrl(result.public_id, { width: 640, height: 640, crop: 'limit' }),
      detail: deliveryUrl(result.public_id, { width: 1400, height: 1400, crop: 'limit' }),
      banner: deliveryUrl(result.public_id, { width: 1800, height: 720, crop: 'fill', gravity: 'auto' }),
    },
  };
}

export async function deleteCatalogImage(publicId) {
  if (!configured) throw new AppError('Cloudinary image storage is not configured', 503, 'IMAGE_STORAGE_NOT_CONFIGURED');
  const root = `${env.CLOUDINARY_FOLDER}/`;
  if (!publicId || !String(publicId).startsWith(root)) {
    throw new AppError('Invalid managed image identifier', 422, 'INVALID_IMAGE_ID');
  }
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
}

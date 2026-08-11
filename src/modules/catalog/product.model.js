import mongoose from 'mongoose';

const barcodeSchema = new mongoose.Schema({
  value: { type: String, trim: true },
  format: { type: String, trim: true, default: 'EAN-13' },
  source: { type: String, trim: true, default: 'client' },
}, { _id: false });

const variantSchema = new mongoose.Schema({
  title: { type: String, trim: true, required: true },
  unit: { type: String, trim: true, required: true },
  sku: { type: String, trim: true, required: true },
  barcode: barcodeSchema,
  mrp: { type: Number, min: 0, required: true },
  price: { type: Number, min: 0, required: true },
  stock: { type: Number, min: 0, default: 0 },
  reservedStock: { type: Number, min: 0, default: 0 },
  images: [{ type: String, trim: true }],
  isDefault: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
}, { timestamps: false });

const productSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true, index: 'text' },
  slug: { type: String, trim: true, unique: true, index: true, required: true },
  description: { type: String, trim: true, default: '' },
  category: { type: String, trim: true, required: true, index: true },
  categoryRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', index: true },
  subcategoryRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', index: true },
  brand: { type: String, trim: true, default: '' },
  image: { type: String, trim: true, default: '' },
  gallery: [{ type: String, trim: true }],
  mrp: { type: Number, min: 0, required: true },
  price: { type: Number, min: 0, required: true },
  discount: { type: Number, min: 0, max: 100, default: 0 },
  unit: { type: String, trim: true, required: true },
  rating: { type: Number, min: 0, max: 5, default: 0 },
  ratingCount: { type: Number, min: 0, default: 0 },
  stock: { type: Number, min: 0, default: 0, index: true },
  reservedStock: { type: Number, min: 0, default: 0 },
  sku: { type: String, trim: true, unique: true, required: true },
  barcode: barcodeSchema,
  variants: { type: [variantSchema], default: [] },
  highlights: [{ type: String, trim: true }],
  tags: [{ type: String, trim: true, lowercase: true }],
  manufacturer: { type: String, trim: true, default: '' },
  countryOfOrigin: { type: String, trim: true, default: 'India' },
  shelfLife: { type: String, trim: true, default: '' },
  storageInstructions: { type: String, trim: true, default: '' },
  isVegetarian: { type: Boolean, default: true },
  isFeatured: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true, index: true },
  popularity: { type: Number, default: 0 },
  taxRate: { type: Number, min: 0, max: 100, default: 0 },
}, { timestamps: true });

productSchema.pre('validate', function syncDefaultVariant() {
  if (!this.variants?.length) return;
  const selected = this.variants.find((variant) => variant.isDefault && variant.isActive)
    || this.variants.find((variant) => variant.isActive)
    || this.variants[0];
  for (const variant of this.variants) variant.isDefault = variant === selected;
  this.sku = selected.sku;
  this.unit = selected.unit;
  this.mrp = selected.mrp;
  this.price = selected.price;
  this.stock = selected.stock;
  this.reservedStock = selected.reservedStock;
  this.barcode = selected.barcode;
  this.discount = selected.mrp > 0 ? Math.round(((selected.mrp - selected.price) / selected.mrp) * 100) : 0;
  if (!this.image && selected.images?.length) this.image = selected.images[0];
});

productSchema.path('price').validate(function priceDoesNotExceedMrp(value) {
  return value <= this.mrp;
}, 'Price cannot exceed MRP');

productSchema.index({ name: 'text', description: 'text', brand: 'text', sku: 'text', 'barcode.value': 'text', tags: 'text' });
productSchema.index({ categoryRef: 1, subcategoryRef: 1, isActive: 1 });
productSchema.index({ 'variants.sku': 1 }, { unique: true, sparse: true });
productSchema.index({ 'variants.barcode.value': 1 }, { sparse: true });

export const Product = mongoose.model('Product', productSchema);

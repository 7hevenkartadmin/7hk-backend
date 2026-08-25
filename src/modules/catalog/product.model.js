import mongoose from 'mongoose';
import { generateSku } from './catalog.sku.js';

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

variantSchema.path('reservedStock').validate(function reservedDoesNotExceedStock(value) {
  return Number(value || 0) <= Number(this.stock || 0);
}, 'Reserved stock cannot exceed on-hand stock');

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
  totalStock: { type: Number, min: 0, default: 0, index: true },
  availableStock: { type: Number, min: 0, default: 0, index: true },
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
  if (!this.variants?.length) {
    if (!this.sku) this.sku = generateSku();
    this.variants = [{
      title: this.unit || 'Default',
      unit: this.unit,
      sku: this.sku,
      barcode: this.barcode,
      mrp: this.mrp,
      price: this.price,
      stock: this.stock,
      reservedStock: this.reservedStock,
      images: this.image ? [this.image] : [],
      isDefault: true,
      isActive: this.isActive !== false,
    }];
  } else {
    const used = new Set(this.variants.map((variant) => String(variant.sku || '').trim().toUpperCase()).filter(Boolean));
    for (const variant of this.variants) {
      if (variant.sku) continue;
      let sku = generateSku();
      while (used.has(sku)) sku = generateSku();
      variant.sku = sku;
      used.add(sku);
    }
  }
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
  const activeVariants = this.variants.filter((variant) => variant.isActive);
  this.totalStock = activeVariants.reduce((sum, variant) => sum + Number(variant.stock || 0), 0);
  this.availableStock = activeVariants.reduce(
    (sum, variant) => sum + Math.max(0, Number(variant.stock || 0) - Number(variant.reservedStock || 0)),
    0,
  );
  this.discount = selected.mrp > 0 ? Math.round(((selected.mrp - selected.price) / selected.mrp) * 100) : 0;
  if (!this.image && selected.images?.length) this.image = selected.images[0];
});

productSchema.path('reservedStock').validate(function reservedDoesNotExceedStock(value) {
  return Number(value || 0) <= Number(this.stock || 0);
}, 'Reserved stock cannot exceed on-hand stock');

productSchema.path('price').validate(function priceDoesNotExceedMrp(value) {
  return value <= this.mrp;
}, 'Price cannot exceed MRP');

productSchema.path('variants').validate((variants) => {
  const skus = (variants || []).map((variant) => String(variant.sku || '').trim().toUpperCase()).filter(Boolean);
  return skus.length === new Set(skus).size;
}, 'Every product variant must have a unique SKU');

productSchema.index({ name: 'text', description: 'text', brand: 'text', sku: 'text', 'barcode.value': 'text', tags: 'text' });
productSchema.index({ categoryRef: 1, subcategoryRef: 1, isActive: 1 });
productSchema.index({ 'variants.sku': 1 }, { unique: true, sparse: true });
productSchema.index({ 'variants.barcode.value': 1 }, { sparse: true });

export const Product = mongoose.model('Product', productSchema);

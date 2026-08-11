
import mongoose from 'mongoose';

const categorySchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true },
  slug: { type: String, trim: true, unique: true, index: true, required: true },
  description: { type: String, trim: true, default: '' },
  icon: { type: String, trim: true, default: 'ShoppingBasket' },
  image: { type: String, trim: true, default: '' },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
  isActive: { type: Boolean, default: true, index: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

categorySchema.index({ parent: 1, sortOrder: 1, name: 1 });

export const Category = mongoose.model('Category', categorySchema);

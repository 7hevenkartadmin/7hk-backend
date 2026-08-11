import { z } from "zod";

export const addressSchema = z.object({
  label: z.string().max(40).default("Home"),
  flatNumber: z.string().max(100).optional().default(""),
  formattedAddress: z.string().max(240).optional().default(""),
  recipientName: z.string().min(2).max(80),
  phone: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(10).max(20).optional().default(""),
  ),
  line1: z.string().min(4).max(160),
  line2: z.string().max(160).optional().default(""),
  landmark: z.string().max(120).optional().default(""),
  city: z.string().min(2).max(80),
  state: z.string().min(2).max(80).default("Bihar"),
  pincode: z.string().min(5).max(10),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  isDefault: z.boolean().default(false),
});

export const updateProfileSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  email: z.string().email().optional(),
});

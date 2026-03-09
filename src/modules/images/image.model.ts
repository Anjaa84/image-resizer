import { Schema, model, type Document, type Types } from 'mongoose';

export type ImageStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface IImage extends Document {
  _id: Types.ObjectId;
  originalName: string;
  originalPath: string;
  outputPath?: string;
  outputUrl?: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  targetWidth: number;
  targetHeight: number;
  format: 'jpeg' | 'png' | 'webp' | 'avif';
  quality: number;
  status: ImageStatus;
  jobId?: string;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ImageSchema = new Schema<IImage>(
  {
    originalName: { type: String, required: true },
    originalPath: { type: String, required: true },
    outputPath: { type: String },
    outputUrl: { type: String },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    targetWidth: { type: Number, required: true },
    targetHeight: { type: Number, required: true },
    format: { type: String, enum: ['jpeg', 'png', 'webp', 'avif'], required: true },
    quality: { type: Number, default: 80 },
    status: { type: String, enum: ['pending', 'processing', 'done', 'failed'], default: 'pending' },
    jobId: { type: String },
    errorMessage: { type: String },
  },
  { timestamps: true },
);

export const ImageModel = model<IImage>('Image', ImageSchema);

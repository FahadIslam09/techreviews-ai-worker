import mongoose from 'mongoose';

const PostSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    content: { type: String, required: true },
    quickSpecs: { type: Map, of: String, default: {} },
    fullSpecifications: { type: mongoose.Schema.Types.Mixed, default: {} }, 
    prosCons: {
      pros: { type: [String], default: [] },
      cons: { type: [String], default: [] },
    },
    performanceRatings: {
      regularUsage: { type: Number, default: 6 },
      gaming: { type: Number, default: 6 },
      multitasking: { type: Number, default: 6 },
      thermalManagement: { type: Number, default: 6 },
    },
    cameraRatings: {
      outdoor: { type: Number, default: 8 },
      indoor: { type: Number, default: 7 },
      lowLight: { type: Number, default: 6 },
      zoom: { type: Number, default: 6 },
    },
    thumbnail: { type: String, required: true },
    videoId: { type: String, required: true },
    originalCreator: { type: String, required: true },
    metaData: {
      metaTitle: { type: String, required: true },
      metaDescription: { type: String, required: true },
      focusKeyword: { type: String, required: true },
    },
    faqData: { type: [{ question: { type: String }, answer: { type: String } }], default: [] },
    imageAltText: { type: String, default: '' },
    readingTime: { type: Number, default: 3 },
    status: { type: String, enum: ['Draft', 'Published'], default: 'Draft' },
  },
  { timestamps: true }
);

const Post = mongoose.models.Post || mongoose.model('Post', PostSchema);
export default Post;
const mongoose = require('mongoose');
const { Schema } = mongoose;

const SubscriptionPaymentSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  plan: { type: String, enum: ['Free Trial', 'KONTRONIX', 'SOPAS', 'RTPAS'], required: true },
  amount: { type: Number, required: true }, // in paise
  currency: { type: String, default: 'INR' },
  razorpayOrderId: { type: String, required: true },
  razorpayPaymentId: { type: String, required: true, unique: true },
  razorpaySignature: { type: String, required: true },
  status: { type: String, enum: ['paid'], default: 'paid' },
}, { timestamps: true });

const SubscriptionPayment = mongoose.model('SubscriptionPayment', SubscriptionPaymentSchema);

module.exports = { SubscriptionPayment };

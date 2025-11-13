const mongoose = require('mongoose');
const { Schema } = mongoose;

const SubscriptionOrderSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  plan: { type: String, enum: ['Free Trial', 'KONTRONIX', 'SOPAS', 'RTPAS'], required: true },
  amount: { type: Number, required: true }, // in paise
  currency: { type: String, default: 'INR' },
  razorpayOrderId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created' },
}, { timestamps: true });

const SubscriptionOrder = mongoose.model('SubscriptionOrder', SubscriptionOrderSchema);

module.exports = { SubscriptionOrder };

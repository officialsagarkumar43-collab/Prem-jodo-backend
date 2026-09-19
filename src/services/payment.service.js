import Razorpay from 'razorpay';
import crypto from 'crypto';
import { ENV } from '../config/env.js';

/**
 * Dedicated Payment Gateway Service (Razorpay PG)
 */
class PaymentService {
  constructor() {
    this.initialized = false;
    this.razorpay = null;
    this.init();
  }

  /**
   * Initialize Razorpay SDK configuration
   */
  init() {
    const keyId = ENV.RAZORPAY_KEY_ID;
    const keySecret = ENV.RAZORPAY_KEY_SECRET;
    const webhookSecret = ENV.RAZORPAY_WEBHOOK_SECRET;

    this.keyId = keyId;
    this.keySecret = keySecret;
    this.webhookSecret = webhookSecret;
    this.isConfigured = Boolean(keyId && keySecret);

    if (this.isConfigured) {
      try {
        this.razorpay = new Razorpay({
          key_id: keyId,
          key_secret: keySecret
        });
        this.initialized = true;
        console.log(`✅ Razorpay Payment Gateway initialized with Key ID: [${keyId.slice(0, 8)}...]`);
      } catch (err) {
        console.error('❌ Failed to instantiate Razorpay client:', err.message);
        this.initialized = false;
      }
    } else {
      console.warn(
        '⚠️ RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not configured in .env. Razorpay API calls will require valid credentials.'
      );
      this.initialized = false;
    }
  }

  /**
   * Create Razorpay Payment Order
   * @param {Object} params
   * @param {number} params.orderAmount - Amount in INR (e.g. 50, 599, 999)
   * @param {string} [params.orderCurrency] - Currency code (default: 'INR')
   * @param {string} [params.receipt] - Unique receipt ID (max 40 chars)
   * @param {Object} [params.notes] - Key-value metadata notes
   */
  async createOrder({
    orderAmount,
    orderCurrency = 'INR',
    receipt,
    notes = {}
  }) {
    if (!this.isConfigured || !this.razorpay) {
      throw new Error(
        'Razorpay Gateway credentials (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) are missing in .env.'
      );
    }

    const amountInPaise = Math.round(Number(orderAmount) * 100);

    if (isNaN(amountInPaise) || amountInPaise <= 0) {
      throw new Error('Valid order amount greater than 0 is required');
    }

    // Razorpay receipt length constraint: max 40 characters
    const trimmedReceipt = receipt ? String(receipt).slice(0, 40) : `rec_${Date.now()}`.slice(0, 40);

    const orderOptions = {
      amount: amountInPaise,
      currency: orderCurrency || 'INR',
      receipt: trimmedReceipt,
      notes: notes && typeof notes === 'object' ? notes : {}
    };

    try {
      const order = await this.razorpay.orders.create(orderOptions);

      return {
        success: true,
        orderId: order.id,
        amount: order.amount,
        amountInRupees: order.amount / 100,
        currency: order.currency,
        receipt: order.receipt,
        status: order.status,
        keyId: this.keyId,
        raw: order
      };
    } catch (err) {
      console.error('❌ Razorpay createOrder failed:', err.message || err);
      throw new Error(`Razorpay Order Creation Failed: ${err.message || 'Unknown error'}`);
    }
  }

  /**
   * Verify Razorpay Payment Signature
   * @param {Object} params
   * @param {string} params.orderId - Razorpay Order ID (e.g. 'order_DBJOWzybf0sJbb')
   * @param {string} params.paymentId - Razorpay Payment ID (e.g. 'pay_29QQoUBi66xm2f')
   * @param {string} params.signature - Razorpay signature received from frontend
   * @returns {boolean}
   */

  verifyPaymentSignature({ orderId, paymentId, signature }) {
    if (!this.isConfigured) {
      throw new Error('Razorpay Gateway credentials not configured for signature verification');
    }

    if (!orderId || !paymentId || !signature) {
      return false;
    }

    try {
      const body = `${orderId}|${paymentId}`;
      const expectedSignature = crypto
        .createHmac('sha256', this.keySecret)
        .update(body)
        .digest('hex');

      return expectedSignature === signature;
    } catch (err) {
      console.error('❌ Razorpay signature verification error:', err.message);
      return false;
    }
  }

  /**
   * Get Order Details from Razorpay
   * @param {string} orderId - Razorpay Order ID
   */
  async getOrder(orderId) {
    if (!this.isConfigured || !this.razorpay) {
      throw new Error('Razorpay Gateway credentials not configured');
    }

    try {
      const order = await this.razorpay.orders.fetch(orderId);
      return order;
    } catch (err) {
      console.error(`❌ Razorpay getOrder failed for ${orderId}:`, err.message);
      throw new Error(`Razorpay Fetch Order Failed: ${err.message}`);
    }
  }

  /**
   * Get Payment Details from Razorpay
   * @param {string} paymentId - Razorpay Payment ID
   */
  async getPayment(paymentId) {
    if (!this.isConfigured || !this.razorpay) {
      throw new Error('Razorpay Gateway credentials not configured');
    }

    try {
      const payment = await this.razorpay.payments.fetch(paymentId);
      return payment;
    } catch (err) {
      console.error(`❌ Razorpay getPayment failed for ${paymentId}:`, err.message);
      throw new Error(`Razorpay Fetch Payment Failed: ${err.message}`);
    }
  }

  /**
   * Get all Payment attempts for an Order
   * @param {string} orderId - Razorpay Order ID
   */
  async getOrderPayments(orderId) {
    if (!this.isConfigured || !this.razorpay) {
      throw new Error('Razorpay Gateway credentials not configured');
    }

    try {
      const response = await this.razorpay.orders.fetchPayments(orderId);
      const items = response?.items || [];
      return Array.isArray(items) ? items : [items];
    } catch (err) {
      console.warn(`⚠️ Razorpay getOrderPayments warning for ${orderId}:`, err.message);
      return [];
    }
  }

  /**
   * Verify Razorpay Webhook Signature
   * @param {Object} params
   * @param {string} params.signature - Header 'x-razorpay-signature'
   * @param {string|Buffer} params.rawBody - Raw request body string
   * @param {string} [params.secret] - Optional custom webhook secret (defaults to ENV.RAZORPAY_WEBHOOK_SECRET || ENV.RAZORPAY_KEY_SECRET)
   * @returns {boolean}
   */
  verifyWebhookSignature({ signature, rawBody, secret }) {
    const webhookSecret = secret || this.webhookSecret || this.keySecret;

    if (!webhookSecret) {
      console.warn('⚠️ Razorpay webhook secret or key secret is not configured');
      return false;
    }

    if (!signature) {
      return false;
    }

    try {
      const payload = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(payload)
        .digest('hex');

      return expectedSignature === signature;
    } catch (err) {
      console.error('❌ Razorpay webhook signature verification error:', err.message);
      return false;
    }
  }

  /**
   * Initiate a Refund for a Payment
   * @param {Object} params
   * @param {string} params.paymentId - Razorpay Payment ID (e.g. 'pay_xxxxxx')
   * @param {number} params.refundAmount - Amount in INR (e.g. 50, 599)
   * @param {string} [params.refundNote] - Reason/note for refund
   * @param {string} [params.refundSpeed] - 'normal' or 'optimum'
   * @param {Object} [params.notes] - Additional metadata notes
   */
  async initiateRefund({
    paymentId,
    refundAmount,
    refundNote = 'Membership cancellation refund',
    refundSpeed = 'normal',
    notes = {}
  }) {
    if (!this.isConfigured || !this.razorpay) {
      throw new Error('Razorpay Gateway credentials not configured');
    }

    if (!paymentId) {
      throw new Error('Payment ID is required to initiate Razorpay refund');
    }

    const refundAmountInPaise = Math.round(Number(refundAmount) * 100);

    const refundPayload = {
      amount: refundAmountInPaise,
      speed: refundSpeed === 'INSTANT' ? 'optimum' : 'normal',
      notes: {
        reason: refundNote,
        ...notes
      }
    };

    try {
      const refund = await this.razorpay.payments.refund(paymentId, refundPayload);

      return {
        success: true,
        refundId: refund.id,
        paymentId: refund.payment_id,
        refundStatus: refund.status,
        refundAmount: refund.amount / 100,
        refundArn: refund.acquirer_data?.arn || refund.arn || null,
        createdAt: refund.created_at,
        raw: refund
      };
    } catch (err) {
      console.error(`❌ Razorpay initiateRefund failed for ${paymentId}:`, err.message || err);
      throw new Error(`Razorpay Refund Failed: ${err.message || 'Unknown error'}`);
    }
  }

  /**
   * Get Refund Status
   * @param {string} refundId - Razorpay Refund ID (e.g. 'rfnd_xxxxxx')
   */
  async getRefundStatus(refundId) {
    if (!this.isConfigured || !this.razorpay) {
      throw new Error('Razorpay Gateway credentials not configured');
    }

    try {
      const refund = await this.razorpay.refunds.fetch(refundId);
      return refund;
    } catch (err) {
      console.error(`❌ Razorpay getRefundStatus failed for ${refundId}:`, err.message);
      throw new Error(`Razorpay Fetch Refund Failed: ${err.message}`);
    }
  }
}

// Export singleton instance
export const paymentService = new PaymentService();
export { PaymentService };

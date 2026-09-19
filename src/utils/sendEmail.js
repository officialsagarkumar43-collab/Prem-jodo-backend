import nodemailer from 'nodemailer';
import { ENV } from '../config/env.js';

/**
 * Configure Nodemailer Transporter
 */
const createTransporter = () => {
  if (ENV.SMTP_USER && ENV.SMTP_PASS && ENV.SMTP_PASS !== 'your_gmail_app_password') {
    return nodemailer.createTransport({
      host: ENV.SMTP_HOST,
      port: Number(ENV.SMTP_PORT),
      secure: Number(ENV.SMTP_PORT) === 465, // true for 465, false for other ports (587)
      auth: {
        user: ENV.SMTP_USER,
        pass: ENV.SMTP_PASS
      }
    });
  }
  return null;
};

/**
 * Send OTP Email via Nodemailer with rich HTML template
 */
export const sendOtpEmail = async (email, otp) => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🔑 Prem Jodo OTP for ${email}: [ ${otp} ]`);
  console.log('   (Valid for 10 minutes)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const transporter = createTransporter();

  if (!transporter) {
    console.log('ℹ️  SMTP credentials not configured or using placeholders. OTP logged above for testing.');
    return true;
  }

  const mailOptions = {
    from: ENV.SMTP_FROM,
    to: email,
    subject: `Your Prem Jodo Verification Code: ${otp}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0f1117; color: #ffffff; padding: 20px; }
          .container { max-width: 520px; margin: 0 auto; background: #1a1d26; border-radius: 16px; padding: 32px; border: 1px solid #2d3139; }
          .logo { text-align: center; margin-bottom: 24px; }
          .logo-text { font-size: 26px; font-weight: 700; color: #ff2d55; letter-spacing: -0.5px; }
          .title { font-size: 20px; font-weight: 600; color: #ffffff; margin-bottom: 12px; text-align: center; }
          .subtitle { font-size: 14px; color: #9aa0a6; line-height: 1.5; text-align: center; margin-bottom: 28px; }
          .otp-box { background: linear-gradient(135deg, rgba(255, 45, 85, 0.1), rgba(255, 107, 107, 0.05)); border: 2px dashed #ff2d55; border-radius: 12px; padding: 18px; text-align: center; margin-bottom: 24px; }
          .otp-code { font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #ff2d55; }
          .footer { font-size: 12px; color: #6b7280; text-align: center; margin-top: 24px; border-top: 1px solid #2d3139; padding-top: 16px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="logo">
            <span class="logo-text">💍 Prem Jodo</span>
          </div>
          <div class="title">Verification Code</div>
          <div class="subtitle">Use the verification code below to log into your Prem Jodo account. This code is valid for <strong>10 minutes</strong>.</div>
          
          <div class="otp-box">
            <span class="otp-code">${otp}</span>
          </div>

          <p style="font-size: 13px; color: #9aa0a6; text-align: center; margin: 0;">
            If you did not request this verification code, please ignore this email.
          </p>

          <div class="footer">
            &copy; ${new Date().getFullYear()} Prem Jodo. All rights reserved.
          </div>
        </div>
      </body>
      </html>
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`✉️ Email sent successfully to ${email} (MessageId: ${info.messageId})`);
    return true;
  } catch (error) {
    console.error('❌ Failed to send email via Nodemailer:', error.message);
    return false;
  }
};

import dns from 'dns';
import nodemailer from 'nodemailer';
import { ENV } from '../config/env.js';

// Custom DNS lookup handler to strictly resolve IPv4 on cloud environments like Render
const ipv4Lookup = (hostname, options, callback) => {
  return dns.lookup(hostname, { family: 4 }, callback);
};

let cachedTransporter = null;

/**
 * Configure Nodemailer Transporter
 */
const createTransporter = () => {
  if (cachedTransporter) return cachedTransporter;

  if (ENV.SMTP_USER && ENV.SMTP_PASS) {
    const cleanPass = String(ENV.SMTP_PASS).replace(/\s+/g, '');
    const port = Number(ENV.SMTP_PORT) || 587;
    const isPort465 = port === 465;

    cachedTransporter = nodemailer.createTransport({
      host: ENV.SMTP_HOST || 'smtp.gmail.com',
      port: port,
      secure: isPort465, // true for 465, false for 587
      requireTLS: !isPort465, // Enforce STARTTLS for port 587
      lookup: ipv4Lookup, // Strictly force IPv4 DNS resolution (bypasses Render IPv6 ENETUNREACH)
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
      auth: {
        user: ENV.SMTP_USER,
        pass: cleanPass
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    return cachedTransporter;
  }
  return null;
};

/**
 * Send OTP Email via Brevo REST API (Free 300 emails/day to ANY recipient without domain verification)
 */
const sendViaBrevo = async (email, otp, htmlContent) => {
  try {
    const cleanApiKey = (ENV.BREVO_API_KEY || '').trim().replace(/^["',]+|["',]+$/g, '');
    const senderEmail = ENV.SMTP_USER || 'officialsagarkumar43@gmail.com';
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': cleanApiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'Prem Jodo', email: senderEmail },
        to: [{ email: email }],
        subject: `Your Prem Jodo Verification Code: ${otp}`,
        htmlContent: htmlContent
      })
    });

    const data = await response.json();
    if (response.ok) {
      console.log(`✉️ Email sent successfully via Brevo API to ${email} (MessageId: ${data.messageId || 'OK'})`);
      return true;
    } else {
      console.error('❌ Brevo API Error:', data);
      return false;
    }
  } catch (err) {
    console.error('❌ Brevo API Network Error:', err.message);
    return false;
  }
};

/**
 * Send OTP Email via Resend REST API (HTTP Port 443 - Never blocked on Render/Cloud)
 */
const sendViaResend = async (email, otp, htmlContent) => {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ENV.RESEND_API_KEY.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: ENV.SMTP_FROM || 'Prem Jodo <onboarding@resend.dev>',
        to: [email],
        subject: `Your Prem Jodo Verification Code: ${otp}`,
        html: htmlContent
      })
    });

    const data = await response.json();
    if (response.ok) {
      console.log(`✉️ Email sent successfully via Resend API to ${email} (Id: ${data.id})`);
      return true;
    } else {
      console.error('❌ Resend API Error:', data);
      return false;
    }
  } catch (err) {
    console.error('❌ Resend API Network Error:', err.message);
    return false;
  }
};

/**
 * Send OTP Email
 */
export const sendOtpEmail = async (email, otp) => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🔑 Prem Jodo OTP for ${email}: [ ${otp} ]`);
  console.log('   (Valid for 10 minutes)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const htmlContent = `
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
  `;

  // 1. If Brevo API Key is available, use Brevo REST API (Allows ANY recipient without custom domain!)
  if (ENV.BREVO_API_KEY) {
    return await sendViaBrevo(email, otp, htmlContent);
  }

  // 2. If Resend API Key is available, use Resend API directly (HTTP Port 443)
  if (ENV.RESEND_API_KEY) {
    return await sendViaResend(email, otp, htmlContent);
  }

  // 2. Fallback to Nodemailer SMTP
  const transporter = createTransporter();

  if (!transporter) {
    console.log('ℹ️  SMTP credentials not configured or using placeholders. OTP logged above for testing.');
    return true;
  }

  const mailOptions = {
    from: ENV.SMTP_FROM || `"Prem Jodo" <${ENV.SMTP_USER}>`,
    to: email,
    subject: `Your Prem Jodo Verification Code: ${otp}`,
    html: htmlContent
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`✉️ Email sent successfully via Nodemailer to ${email} (MessageId: ${info.messageId})`);
    return true;
  } catch (error) {
    console.error('❌ Failed to send email via Nodemailer:', error.message);
    return false;
  }
};

/**
 * Send Support Ticket Reply Email to user / guest candidate
 * Clean plain mail format: pure white background, 12px brand header, no personal admin name.
 * Highlights Ticket Subject/Category and User's submitted Description.
 */
export const sendTicketReplyEmail = async ({
  to,
  recipientName,
  ticketId,
  ticketSubject,
  userDescription,
  replyMessage,
  status = 'In Progress'
}) => {
  if (!to) return false;

  console.log(`✉️ Sending support ticket reply email to ${to} for ticket [${ticketId}]...`);

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          background-color: #ffffff;
          color: #222222;
          margin: 0;
          padding: 20px;
          font-size: 14px;
          line-height: 1.6;
        }
        .wrapper {
          max-width: 600px;
          margin: 0 auto;
          background-color: #ffffff;
        }
        .support-header {
          font-size: 12px;
          font-weight: 600;
          color: #777777;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 20px;
          padding-bottom: 8px;
          border-bottom: 1px solid #eeeeee;
        }
        .greeting {
          font-size: 15px;
          font-weight: 600;
          color: #111111;
          margin-bottom: 14px;
        }
        .highlight-card {
          margin: 18px 0;
          padding: 14px 16px;
          border-left: 3px solid #ff2d55;
          background-color: #fbfbfb;
          border-radius: 4px;
        }
        .highlight-label {
          font-size: 11px;
          font-weight: 700;
          color: #888888;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 4px;
        }
        .subject-val {
          font-size: 15px;
          font-weight: 700;
          color: #111111;
          margin-bottom: 12px;
        }
        .desc-text {
          font-size: 13.5px;
          color: #444444;
          line-height: 1.6;
          white-space: pre-wrap;
          margin: 0;
        }
        .reply-section {
          margin: 24px 0;
        }
        .reply-label {
          font-size: 11px;
          font-weight: 700;
          color: #ff2d55;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        }
        .reply-body {
          font-size: 14.5px;
          color: #222222;
          white-space: pre-wrap;
          line-height: 1.7;
          margin: 0;
        }
        .ticket-meta {
          font-size: 13px;
          color: #666666;
          margin-top: 24px;
          padding-top: 14px;
          border-top: 1px solid #eeeeee;
        }
        .signoff {
          margin-top: 24px;
          font-size: 14px;
          color: #333333;
        }
        .footer {
          font-size: 11px;
          color: #999999;
          margin-top: 28px;
          border-top: 1px solid #eeeeee;
          padding-top: 12px;
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="support-header">
          Prem Jodo Support &bull; Ticket #${ticketId}
        </div>

        <div class="greeting">Hello ${recipientName || 'Member'},</div>

        <p style="margin: 0 0 14px 0; color: #555555;">
          Our support team has updated your ticket with a response. Below are the details:
        </p>

        <!-- Highlighted Topic / Subject & User Description -->
        <div class="highlight-card">
          <div class="highlight-label">Topic / Category</div>
          <div class="subject-val">${ticketSubject || 'General Support'}</div>

          ${
            userDescription
              ? `
            <div class="highlight-label" style="margin-top: 10px;">Your Inquiry / Description</div>
            <p class="desc-text">${userDescription}</p>
          `
              : ''
          }
        </div>

        <!-- Support Team Reply -->
        <div class="reply-section">
          <div class="reply-label">Response from Prem Jodo Support</div>
          <p class="reply-body">${replyMessage}</p>
        </div>

        <div class="ticket-meta">
          <strong>Ticket ID:</strong> ${ticketId}<br>
          <strong>Status:</strong> ${status || 'In Progress'}
        </div>

        <div class="signoff">
          Regards,<br>
          <strong>Prem Jodo Support Team</strong>
        </div>

        <div class="footer">
          This is an automated support response from Prem Jodo. If you have any further questions, please reply directly to this email.
        </div>
      </div>
    </body>
    </html>
  `;

  const emailSubject = `[${ticketId}] Prem Jodo Support Update`;

  // 1. Brevo REST API
  if (ENV.BREVO_API_KEY) {
    try {
      const cleanApiKey = (ENV.BREVO_API_KEY || '').trim().replace(/^["',]+|["',]+$/g, '');
      const senderEmail = ENV.SMTP_USER || 'officialsagarkumar43@gmail.com';
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': cleanApiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          sender: { name: 'Prem Jodo Support', email: senderEmail },
          to: [{ email: to, name: recipientName }],
          subject: emailSubject,
          htmlContent: htmlContent
        })
      });
      if (response.ok) {
        console.log(`✉️ Ticket reply email sent to ${to} via Brevo`);
        return true;
      }
    } catch (err) {
      console.warn('Brevo reply email error:', err.message);
    }
  }

  // 2. Resend API
  if (ENV.RESEND_API_KEY) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ENV.RESEND_API_KEY.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: ENV.SMTP_FROM || 'Prem Jodo Support <support@resend.dev>',
          to: [to],
          subject: emailSubject,
          html: htmlContent
        })
      });
      if (response.ok) {
        console.log(`✉️ Ticket reply email sent to ${to} via Resend`);
        return true;
      }
    } catch (err) {
      console.warn('Resend reply email error:', err.message);
    }
  }

  // 3. Fallback to Nodemailer SMTP
  const transporter = createTransporter();
  if (transporter) {
    try {
      await transporter.sendMail({
        from: ENV.SMTP_FROM || `"Prem Jodo Support" <${ENV.SMTP_USER}>`,
        to: to,
        subject: emailSubject,
        html: htmlContent
      });
      console.log(`✉️ Ticket reply email sent to ${to} via Nodemailer`);
      return true;
    } catch (err) {
      console.error('Nodemailer reply email error:', err.message);
      return false;
    }
  }

  console.log(`ℹ️ Email logged for ${to} (no SMTP configured). Message: "${replyMessage}"`);
  return true;
};

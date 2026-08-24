import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/utils/AppError.js';

let transporter;

function configured() {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
}

function mailTransport() {
  if (!configured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      pool: true,
      maxConnections: 3,
    });
  }
  return transporter;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character]);
}

export function adminSecurityUrl(path, token) {
  const base = env.ADMIN_APP_URL.replace(/\/$/u, '');
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

export async function sendAdminActionEmail({ to, name, actionUrl, kind, expiresIn }) {
  const isInvite = kind === 'invite';
  const subject = isInvite ? 'Set up your 7HevenKart administrator account' : 'Reset your 7HevenKart administrator password';
  const action = isInvite ? 'Set up administrator account' : 'Reset administrator password';
  const transport = mailTransport();
  if (!transport) {
    if (env.NODE_ENV === 'production') {
      throw new AppError('Security email delivery is unavailable', 503, 'SECURITY_EMAIL_UNAVAILABLE');
    }
    return { delivered: false, previewUrl: actionUrl };
  }

  try {
    const info = await transport.sendMail({
      from: env.SMTP_FROM,
      to,
      subject,
      text: `Hello ${name},\n\n${action}: ${actionUrl}\n\nThis one-time link expires in ${expiresIn}. If you did not expect this, contact the store owner.`,
      html: `<p>Hello ${escapeHtml(name)},</p><p>Use the secure one-time link below. It expires in ${escapeHtml(expiresIn)}.</p><p><a href="${escapeHtml(actionUrl)}">${escapeHtml(action)}</a></p><p>If you did not expect this, contact the store owner.</p>`,
    });
    return { delivered: true, messageId: info.messageId };
  } catch (error) {
    const appError = new AppError('Security email could not be delivered', 503, 'SECURITY_EMAIL_UNAVAILABLE');
    appError.cause = error;
    throw appError;
  }
}

export async function sendSecurityNotice({ to, name, subject, message }) {
  const transport = mailTransport();
  if (!transport) return { delivered: false };
  try {
    const info = await transport.sendMail({
      from: env.SMTP_FROM,
      to,
      subject,
      text: `Hello ${name},\n\n${message}\n\nIf you did not expect this, contact the store owner immediately.`,
      html: `<p>Hello ${escapeHtml(name)},</p><p>${escapeHtml(message)}</p><p>If you did not expect this, contact the store owner immediately.</p>`,
    });
    return { delivered: true, messageId: info.messageId };
  } catch {
    return { delivered: false };
  }
}

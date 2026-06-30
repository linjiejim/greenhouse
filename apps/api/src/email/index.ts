/**
 * Email integration — public API.
 *
 * Generic IMAP/SMTP only. Each user can bind up to 10 email accounts independently.
 */

export {
  createEmailClient,
  testEmailConnection,
  encryptCredentials,
  isEncryptionConfigured,
  MAX_EMAIL_ACCOUNTS,
} from './service.js';
export type {
  IEmailClient,
  EmailCredentials,
  ImapCredentials,
  EmailFolder,
  EmailMessageSummary,
  EmailMessageDetail,
  SendEmailOptions,
  EmailListOptions,
  EmailListResult,
  EmailAddress,
} from './types.js';

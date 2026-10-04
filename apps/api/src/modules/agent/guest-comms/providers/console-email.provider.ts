import { Injectable, Logger } from '@nestjs/common';
import type { EmailMessage, EmailProvider, EmailResult } from '../email-provider.interface';
import { notSentEmailResult } from './bounded-email-transport';

/**
 * Development fallback — logs the message instead of sending.
 */
@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleEmailProvider.name);

  isConfigured(): boolean {
    return true;
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    this.logger.log(
      'email_not_sent: console fallback (recipient and body omitted)',
    );
    return {
      ...notSentEmailResult(this.name, 'No email provider configured — message logged only'),
      messageId: message.messageId ?? `console-${Date.now()}`,
    };
  }
}

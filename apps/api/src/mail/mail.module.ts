import { Global, Module } from '@nestjs/common';
import { MailService, MAIL_SERVICE } from './mail.service';

/**
 * Global mail seam. Exposes the concrete `MailService` both
 * directly and under the {@link MAIL_SERVICE} token so consumers depend on the
 * `IMailService` interface and tests can override the token with a mock.
 */
@Global()
@Module({
  providers: [MailService, { provide: MAIL_SERVICE, useExisting: MailService }],
  exports: [MailService, MAIL_SERVICE],
})
export class MailModule {}

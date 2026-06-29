/**
 * UsersModule — admin staff-accounts management.
 *
 * DatabaseService is @Global (no import needed).
 * AuthModule exports PasswordService (argon2id hashing for new accounts).
 * AuditService is @Global.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';
import { UsersAdminController } from './users.controller.admin';

@Module({
  imports: [AuthModule],
  providers: [UsersRepository, UsersService],
  controllers: [UsersAdminController],
})
export class UsersModule {}

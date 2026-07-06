import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Requires a valid `Authorization: Bearer <jwt>` header. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

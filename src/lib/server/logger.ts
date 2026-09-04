import pino from 'pino';
import { env, isProduction } from './env';

/**
 * Structured logger. Redaction is defined here rather than at call sites so a
 * new logging statement cannot accidentally leak a credential.
 */
export const logger = pino({
	level: env.LOG_LEVEL,
	redact: {
		paths: [
			'password',
			'*.password',
			'DATABASE_URL',
			'*.DATABASE_URL',
			'RESTIC_PASSWORD',
			'*.RESTIC_PASSWORD',
			'req.headers.cookie',
			'req.headers.authorization',
			'*.sessionToken',
			'*.token'
		],
		censor: '[redacted]'
	},
	transport: isProduction ? undefined : { target: 'pino/file', options: { destination: 1 } }
});

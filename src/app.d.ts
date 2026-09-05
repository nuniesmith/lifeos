import type { AuthUser } from '$lib/server/auth/service';

declare global {
	namespace App {
		interface Locals {
			user: AuthUser | null;
			sessionId: string | null;
			requestId: string;
		}
		interface Error {
			code?: string;
			requestId?: string;
		}
		interface PageData {
			user?: AuthUser | null;
		}
	}
}

export {};

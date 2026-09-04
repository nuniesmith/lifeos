declare global {
	namespace App {
		interface Locals {
			user: { id: string; email: string; displayName: string; role: 'owner' | 'member' } | null;
			requestId: string;
		}
		interface Error {
			code?: string;
			requestId?: string;
		}
		interface PageData {
			user?: App.Locals['user'];
		}
	}
}

export {};

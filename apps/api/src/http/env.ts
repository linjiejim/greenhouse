import type { MemberRole } from '@greenhouse/db';

/** The signed-in member, read fresh from the database on every request. */
export interface AuthMember {
  id: string;
  role: MemberRole;
  name: string;
  email: string;
}

export type AppEnv = {
  Variables: {
    member: AuthMember;
    requestId: string;
  };
};

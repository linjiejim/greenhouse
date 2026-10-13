import { prepareTestDatabase } from '@greenhouse/db/testing';

/** Once per `db` run: an empty test database with the current migrations applied. */
export default async function setup(): Promise<void> {
  await prepareTestDatabase();
}

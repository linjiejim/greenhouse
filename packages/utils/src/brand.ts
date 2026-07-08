/**
 * Product branding — the single source of truth for the product name.
 *
 * Resolved at CALL time (not module load) so the workspace-settings env
 * overlay (`branding.product_name` DB value → PRODUCT_NAME env var, see
 * apps/api/src/settings/) takes effect without a restart. Falls back to the
 * PRODUCT_NAME env var, then "Greenhouse". Consumed by the API startup
 * banner, the CLI banners, and the agent identity preamble.
 */

export function getProductName(): string {
  return process.env.PRODUCT_NAME || 'Greenhouse';
}

/**
 * Product branding — the single source of truth for the product name.
 *
 * Override with the PRODUCT_NAME env var to white-label the deployment;
 * defaults to "Greenhouse". Consumed by the API startup banner, the CLI
 * banners, the web AppLogo, and the PDF-export footer.
 */

export const PRODUCT_NAME = process.env.PRODUCT_NAME || 'Greenhouse';

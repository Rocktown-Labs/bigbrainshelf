// @bigbrainshelf/api: dedicated API contract and shared service exports
// for the web storefront and mobile app.

export * from "../../../packages/core/src/index";
export {
  getDigitalEntitlements,
  getLibraryBooks,
  loadReaderBook,
  entitlementDownloads,
  formatGrantsDigital,
  formatGrantsAudio,
} from "../../../src/lib/library";
export {
  classifyApiRoute,
  PUBLIC_API_EXACT,
  PUBLIC_API_PREFIXES,
  CUSTOMER_SELF_AUTH_API_ROUTES,
} from "../../../src/lib/route-policy";

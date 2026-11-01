import assert from "node:assert/strict";
import {
  computeLocalConceptEmbedding,
  cosineSimilarity,
  semanticAskTheShelf,
  retrieveCanonContinuity,
  detectBraintrustBackend,
} from "../src/lib/braintrust";
import {
  askCastCompanion,
  getFamilySyncState,
  FamilyRoomDurableObject,
} from "../src/lib/family-sync";
import {
  decideFulfillmentRoute,
  getPhygitalClaim,
} from "../src/lib/fulfillment-router";
import {
  REVOPS_PRICING_MATRIX,
  BIRTHDAY_GIFT_CODE,
  isBirthdayWithinWindow,
  scoreAccountRevOps,
} from "../src/lib/revops";
import { classifyApiRoute } from "../src/lib/route-policy";

async function runTests() {
  // 1. Verify RevOps pricing matrix matches offers.ts and birthday code BDAY10
  assert.equal(REVOPS_PRICING_MATRIX.audioOnlyCents, 199, "Audiobook only must be $1.99");
  assert.equal(REVOPS_PRICING_MATRIX.digitalBundleCents, 899, "Digital bundle must be $8.99");
  assert.equal(REVOPS_PRICING_MATRIX.printedBookCents, 2000, "Printed book must be $20.00");
  assert.equal(REVOPS_PRICING_MATRIX.giftSetCents, 2500, "Gift Set must be $25.00");
  assert.equal(REVOPS_PRICING_MATRIX.bookClubQuarterlyCents, 6000, "Book Club must be $60/quarter");
  assert.equal(REVOPS_PRICING_MATRIX.bookClubAnnualCents, 19900, "Book Club Annual must be $199/year");
  assert.equal(REVOPS_PRICING_MATRIX.audioClubMonthlyCents, 599, "Audio Club must be $5.99/month");
  assert.equal(REVOPS_PRICING_MATRIX.audioClubAnnualCents, 4900, "Audio Club Annual must be $49/year");
  assert.equal(BIRTHDAY_GIFT_CODE, "BDAY10", "Birthday gift code must be BDAY10");

  // 2. Verify Pillar 1 Braintrust Semantic "Ask the Shelf" & Canon Continuity + Honest Backend Labeling
  assert.equal(
    detectBraintrustBackend({}),
    "d1_concept_scaffolding",
    "Unbound Vectorize/AI must honestly report d1_concept_scaffolding"
  );
  assert.equal(
    detectBraintrustBackend({ AI: {} as any, VECTORIZE_CANON: {} as any }),
    "vectorize_edge",
    "Bound Vectorize+AI must report vectorize_edge"
  );

  const mathVec = computeLocalConceptEmbedding("count fibonacci numbers pattern in nature");
  const moneyVec = computeLocalConceptEmbedding("compound interest patience saving money");
  assert.equal(mathVec.length, 32);
  assert.ok(cosineSimilarity(mathVec, mathVec) > 0.99);
  assert.ok(cosineSimilarity(mathVec, moneyVec) < 0.85);

  const shelfMatches = await semanticAskTheShelf("fibonacci patterns in nature pinecones");
  assert.ok(shelfMatches.length > 0, "Semantic search should return matching volumes/chapters");
  assert.equal(shelfMatches[0].recommendedOffer.bundlePrice, "$8.99");
  assert.equal(shelfMatches[0].recommendedOffer.audioClubPrice, "$5.99/mo");
  assert.equal(shelfMatches[0].recommendedOffer.bookClubPrice, "$60/quarter");

  const canonFacts = await retrieveCanonContinuity("Fern notebook quiet observer");
  assert.ok(canonFacts.length > 0, "Canon continuity retrieval should return character/chapter lore");

  // 3. Verify Pillar 3 FamilyRoomDurableObject + D1 Polling Scaffolding Labeling + Cast Companion
  assert.equal(typeof FamilyRoomDurableObject, "function");
  const syncState = await getFamilySyncState(undefined, "user_test_1", {});
  assert.equal(syncState.syncBackend, "d1_polling_scaffolding");
  const syncStateDo = await getFamilySyncState(undefined, "user_test_1", { FAMILY_ROOM_DO: {} });
  assert.equal(syncStateDo.syncBackend, "durable_object");

  const castReply = await askCastCompanion({
    userId: "user_test_1",
    bookSlug: "fern-counts-the-forest",
    characterName: "Fern",
    questionText: "How do sunflower spirals work?",
  });
  assert.equal(castReply.characterName, "Fern");
  assert.equal(castReply.source, "story_canon_scaffolding");
  assert.ok(castReply.responseText.includes("Fern"));
  assert.ok(castReply.comprehensionBadge.includes("Pattern Spotter"));

  // 4. Verify Pillar 4 Hybrid Supply Chain Router (Mode A Shippo vs Mode B International POD vs Mode C 3PL)
  const modeA = decideFulfillmentRoute({
    bookSlug: "fern-counts-the-forest",
    productType: "gift_set",
    destinationCountry: "US",
    quantity: 1,
  });
  assert.equal(modeA.fulfillmentMode, "mode_a_home_shippo");
  assert.equal(modeA.retailPriceCents, 2500);
  assert.equal(modeA.integrationMode, "live_shippo");

  const modeB = decideFulfillmentRoute({
    bookSlug: "fern-counts-the-forest",
    productType: "printed",
    destinationCountry: "GB",
    quantity: 1,
  });
  assert.equal(modeB.fulfillmentMode, "mode_b_pod");
  assert.equal(modeB.providerName, "lulu_gelato_pod");
  assert.equal(modeB.integrationMode, "pod_3pl_routing_scaffolding");

  const modeC = decideFulfillmentRoute({
    bookSlug: "fern-counts-the-forest",
    productType: "club_box",
    destinationCountry: "US",
    quantity: 1,
  });
  assert.equal(modeC.fulfillmentMode, "mode_c_3pl");
  assert.equal(modeC.retailPriceCents, 6000);
  assert.equal(modeC.integrationMode, "pod_3pl_routing_scaffolding");

  const claim = await getPhygitalClaim(undefined, "FERN-DEMO123");
  assert.ok(claim, "FERN-* phygital token should resolve");
  assert.equal(claim?.bookSlug, "fern-counts-the-forest");

  // 5. Verify Pillar 5 Birthday Window (10-day lookahead) & RevOps Account Scoring
  const refDate = new Date("2026-05-01T00:00:00Z");
  const hit = isBirthdayWithinWindow("2020-05-09", refDate, 10);
  assert.equal(hit.matches, true);
  assert.equal(hit.daysUntil, 8);

  const miss = isBirthdayWithinWindow("2020-06-15", refDate, 10);
  assert.equal(miss.matches, false);

  const revScore = scoreAccountRevOps({
    email: "parent@example.com",
    ordersCount: 2,
    totalSpentCents: 3399,
    booksCompletedCount: 2,
    daysSinceLastRead: 3,
    hasActiveClub: false,
  });
  assert.equal(revScore.churnRisk, "low");
  assert.ok(revScore.recommendedPlay.includes("$5.99/mo"));

  // 6. Verify Route Policy classifications for new endpoints
  const emptyParams = new URLSearchParams();
  assert.equal(classifyApiRoute("/api/braintrust", "GET", emptyParams), "public");
  assert.equal(classifyApiRoute("/api/claim", "POST", emptyParams), "public");
  assert.equal(classifyApiRoute("/api/club/retention", "POST", emptyParams), "customer_self_auth");
  assert.equal(classifyApiRoute("/api/account/sync", "GET", emptyParams), "customer_self_auth");
  assert.equal(classifyApiRoute("/api/account/cast-chat", "POST", emptyParams), "customer_self_auth");

  console.log("All Transmedia & RevOps 5-Pillar tests passed!");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

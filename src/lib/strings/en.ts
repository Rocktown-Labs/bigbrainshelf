// Book-page chrome strings, English (the source language).
//
// This module is the Phase 0 string-externalization seam for the book
// detail page (see src/lib/i18n.ts and the i18n readiness plan, Phase
// 0 item 6): the handful of labels a book page needs live here, keyed
// by locale, instead of being hardcoded in .astro templates. Other
// locales (es.ts, ...) implement the same interface. The translated
// template packs produced by the factory translation pilot use the
// same key names, so a finished pack drops in by replacing a file's
// values, not by touching templates.
//
// Keep this surface SMALL: only strings the localized book page
// actually renders. Widen the interface when a new localized surface
// needs a label, not before.

export interface BookPageStrings {
  /** Small badge naming the edition's language, shown on localized pages. */
  editionBadge: string;
  /** Section heading above the format price rows. */
  formatsHeading: string;
  /** Format row labels (mirror src/lib/offers.ts wording in English). */
  digitalLabel: string;
  printLabel: string;
  audioLabel: string;
  giftSetLabel: string;
  /**
   * Disabled-button text on a format that cannot be bought yet. The
   * store's not-sellable treatment (see /merch): prices show, the
   * button is disabled, nothing touches the cart.
   */
  notAvailableButton: string;
  /** Chapter list heading. */
  chaptersHeading: string;
  /** Chapter row prefix; "{n}" is replaced with the chapter number. */
  chapterLabel: string;
  /** Glossary heading (the books' own furniture term). */
  glossaryHeading: string;
  /** Back-cover section heading. */
  backCoverHeading: string;
  /** Link back to the English version of the same page. */
  englishVersionLabel: string;
  /** Back link at the top of the page ("← " stays in the template). */
  backToShelf: string;
  /** Word before the publication date ("Published October 27, 2026"). */
  publishedPrefix: string;
  /** "What's inside" list rows on the book page. */
  includesPicture: string;
  includesColoring: string;
  includesEbook: string;
  includesAudio: string;
  /** Aria label for the "what's inside" list and the format chips row. */
  includesAriaLabel: string;
  /** Format chip labels (title + aria-label on the icon chips). */
  chipStory: string;
  chipColoring: string;
  chipAudio: string;
  /** Word after the title in cover alt text ("{title} cover"). */
  coverAltWord: string;
  /** Shown in place of the buy controls when a book is not buyable. */
  availableSoon: string;
  /** Aria label for the (disabled, on localized pages) format picker. */
  formatPickerLabel: string;
  /** Review count words, singular and plural. */
  reviewOne: string;
  reviewMany: string;
  /** Prefix of the review summary line ("Based on 3 reviews"). */
  basedOnPrefix: string;
  /** Reviews section heading. */
  reviewsHeading: string;
  /** Badge on reviews from a confirmed buyer. */
  verifiedPurchase: string;
  /** Empty-state line under the reviews heading. */
  noReviews: string;
  /** Alt text for reader-uploaded review photos. */
  readerPhotoAlt: string;
  /** Heading of the signed-out review prompt box. */
  reviewPromptHeading: string;
  /** Sign-in link text inside the review prompt. */
  signInLabel: string;
  /** Text after the sign-in link in the review prompt (leading space included). */
  reviewPromptTail: string;
  /** Heading of the signed-in review form box. */
  reviewFormHeading: string;
  /** Review-form intro for a signed-in owner (verified badge). */
  reviewIntroOwner: string;
  /** Review-form intro for a signed-in non-owner (approval queue). */
  reviewIntroGuest: string;
  /** Review-form field labels. */
  reviewNameLabel: string;
  reviewRatingLabel: string;
  reviewRating5: string;
  reviewRating4: string;
  reviewRating3: string;
  reviewRating2: string;
  reviewRating1: string;
  reviewTitleLabel: string;
  reviewTitlePlaceholder: string;
  reviewBodyLabel: string;
  reviewBodyPlaceholder: string;
  reviewPhotosLabel: string;
  reviewVideoLabel: string;
  reviewSubmitLabel: string;
  /** Heading of the "your review" state box. */
  yourReviewHeading: string;
  /** Status lines under the "your review" heading. */
  yourReviewPending: string;
  yourReviewApproved: string;
  yourReviewRejected: string;
  /** Post-submit messages in the review form script. */
  reviewThanksMsg: string;
  reviewErrorMsg: string;
}

export const BOOK_PAGE_STRINGS_EN: BookPageStrings = {
  editionBadge: "English edition",
  formatsHeading: "Formats",
  digitalLabel: "Digital download",
  printLabel: "Printed book",
  audioLabel: "Audiobook only",
  giftSetLabel: "Gift set",
  notAvailableButton: "Coming soon",
  chaptersHeading: "Chapters",
  chapterLabel: "Chapter {n}",
  glossaryHeading: "Words to Know",
  backCoverHeading: "From the back cover",
  englishVersionLabel: "See this page in English",
  backToShelf: "Back to the shelf",
  publishedPrefix: "Published",
  includesPicture: "Storybook (full-color picture book, read-along story)",
  includesColoring: "Coloring book (every page ready to color)",
  includesEbook: "Ebook (the storybook file for a tablet, e-reader, or phone)",
  includesAudio: "Audiobook (the full story, read aloud)",
  includesAriaLabel: "What this book includes",
  chipStory: "Story book",
  chipColoring: "Coloring book",
  chipAudio: "Audiobook",
  coverAltWord: "cover",
  availableSoon: "Available soon.",
  formatPickerLabel: "Choose format",
  reviewOne: "review",
  reviewMany: "reviews",
  basedOnPrefix: "Based on",
  reviewsHeading: "Reader reviews",
  verifiedPurchase: "Verified purchase",
  noReviews: "No reviews yet. Be the first to share what your reader thought.",
  readerPhotoAlt: "Reader photo",
  reviewPromptHeading: "Read this one?",
  signInLabel: "Sign in",
  reviewPromptTail: " to write a review.",
  reviewFormHeading: "Write a review",
  reviewIntroOwner: "You own this book, so your review will carry a Verified purchase badge.",
  reviewIntroGuest: "Reviews come from readers: buy this book or join a club and listen, and you can review it here. Every review is checked by a real person before it appears.",
  reviewNameLabel: "Your name",
  reviewRatingLabel: "Your rating",
  reviewRating5: "5 stars: we love it",
  reviewRating4: "4 stars: really good",
  reviewRating3: "3 stars: it was okay",
  reviewRating2: "2 stars: not for us",
  reviewRating1: "1 star: we did not like it",
  reviewTitleLabel: "Headline",
  reviewTitlePlaceholder: "The part my kid asks for again and again",
  reviewBodyLabel: "Your review",
  reviewBodyPlaceholder: "What did your reader think? What stuck with them?",
  reviewPhotosLabel: "Photos (up to 4, 10MB each)",
  reviewVideoLabel: "Video (one, up to 50MB)",
  reviewSubmitLabel: "Submit review",
  yourReviewHeading: "Your review",
  yourReviewPending: "Thanks for writing it. Your review is in the queue and will appear here once it is approved.",
  yourReviewApproved: "Your review is live on this page. Thank you.",
  yourReviewRejected: "Your earlier review was not approved, so it does not appear here.",
  reviewThanksMsg: "Thank you. Your review is in the queue and will appear here once it is approved.",
  reviewErrorMsg: "Something went wrong. Please try again.",
};

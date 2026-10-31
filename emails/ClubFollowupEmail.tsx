import React from "react";
import { Button, Link, Section, Text } from "@react-email/components";
import { BRAND, EmailLayout, styles } from "./EmailLayout";
import type { ClubFollowupModel } from "../src/lib/marketing";

// The day-3 post-purchase Book Club follow-up. Renders the same words
// and facts as buildClubFollowupEmail's plain text (both come from
// buildClubFollowupModel in src/lib/marketing.ts). Sent from news@ via
// the outbox; the unsubscribe link is a working tokened opt-out.

export default function ClubFollowupEmail({ model }: { model: ClubFollowupModel }) {
  return (
    <EmailLayout preview="A gift set and a second book every 3 months, digital from day one">
      <Text style={styles.heading}>Keep the shelf growing</Text>
      <Text style={styles.paragraph}>
        Thank you again for your Big Brain Shelf order.
      </Text>
      <Text style={styles.paragraph}>
        If your reader is ready for the next big idea, the Book Club is the
        easy way to keep the shelf growing without thinking about it.
      </Text>
      <Text style={styles.paragraph}>
        Members get the club book as a full gift set (the printed
        storybook plus its printed coloring book) and a second printed
        book from the back catalog in each box, plus a sticker sheet and
        a little extra from the cast, and the digital editions in their
        library from the day they join. Membership is {model.priceLabel}{" "}
        every 3 months, shipping included, and your price stays locked
        while the membership stays active. There is also an annual plan
        at {model.annualLabel} a year.
      </Text>
      <Text style={styles.paragraph}>
        Your first box is due the day you join, and a new box follows
        every 3 months from your join date. Membership is capped at 25
        members, so spots are limited.
      </Text>
      <Text style={styles.paragraph}>
        Rather just listen? The Audio Club puts every Big Brain Shelf
        audiobook in your library for {model.audioMonthlyLabel} a month, or{" "}
        {model.audioAnnualLabel} a year, for as long as your membership is
        active. Listening only: nothing ships on that plan.
      </Text>
      <Section style={{ margin: "4px 0 20px" }}>
        <Button
          href={model.clubUrl}
          style={{
            backgroundColor: BRAND.navy,
            color: "#ffffff",
            fontSize: "15px",
            fontWeight: 700,
            padding: "12px 22px",
            borderRadius: "8px",
            textDecoration: "none",
          }}
        >
          Join the Book Club
        </Button>
      </Section>
      <Text style={styles.paragraph}>
        Happy reading,
        <br />
        Big Brain Shelf
      </Text>
      <Text style={styles.muted}>
        You are getting this because you bought a book from Big Brain
        Shelf. Rather not get club news?{" "}
        <Link href={model.unsubscribeUrl} style={{ color: BRAND.navy, textDecoration: "underline" }}>
          Unsubscribe here
        </Link>
        .
      </Text>
    </EmailLayout>
  );
}

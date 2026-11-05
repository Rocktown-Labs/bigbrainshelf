import React from "react";
import { Button, Img, Link, Section, Text } from "@react-email/components";
import { BRAND, EmailLayout, styles } from "./EmailLayout";
import type { ClubCycleEmailModel } from "../src/lib/club-emails";
import { CLUB_BOX_SHIPPED_KIND, CLUB_CYCLE_LOCKED_KIND } from "../src/lib/club-emails";

// Book Club cycle email (reminders, locked, action needed, shipped).
// Renders the same words and facts as buildClubCycleEmailText's plain
// text; both come from buildClubCycleEmailModel in
// src/lib/club-emails.ts. Reminders send from news@ and carry the
// tokened unsubscribe link; the rest are transactional from orders@.
// The locked and shipped emails show the club book's cover under the
// heading (CG, 2026-11-05: the plain wall of text was not exciting);
// reminders and the action-needed email have no resolved book to
// show, and the cover stays off them even if a slot has resolved.

export default function ClubCycleEmail({ model }: { model: ClubCycleEmailModel }) {
  const showCover =
    Boolean(model.bookCoverUrl) &&
    (model.kind === CLUB_CYCLE_LOCKED_KIND || model.kind === CLUB_BOX_SHIPPED_KIND);
  return (
    <EmailLayout preview={model.heading}>
      <Text style={styles.heading}>{model.heading}</Text>
      {showCover ? (
        <Section style={{ margin: "4px 0 16px" }}>
          <Img
            src={model.bookCoverUrl as string}
            alt={`${model.bookTitle || "Your club book"} cover`}
            width="220"
            style={{ borderRadius: "8px", border: `1px solid ${BRAND.line}` }}
          />
        </Section>
      ) : null}
      {model.paragraphs.map((p, i) => (
        <Text key={i} style={styles.paragraph}>
          {p}
        </Text>
      ))}
      <Section style={{ margin: "4px 0 20px" }}>
        <Button
          href={model.accountUrl}
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
          Open your account
        </Button>
      </Section>
      <Text style={styles.paragraph}>
        Happy reading,
        <br />
        Big Brain Shelf
      </Text>
      {model.unsubscribeUrl ? (
        <Text style={styles.muted}>
          Rather not get club news?{" "}
          <Link href={model.unsubscribeUrl} style={{ color: BRAND.navy, textDecoration: "underline" }}>
            Unsubscribe here
          </Link>
          .
        </Text>
      ) : null}
    </EmailLayout>
  );
}

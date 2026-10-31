import React from "react";
import { Button, Img, Link, Section, Text } from "@react-email/components";
import { BRAND, EmailLayout, styles } from "./EmailLayout";
import type { ReleaseEmailModel } from "../src/lib/releases";

// Release announcement. Renders the same words and facts as
// buildReleaseEmail's plain text (both come from buildReleaseModel in
// src/lib/releases.ts). Sent from news@ via the outbox in two waves:
// Book Club members first, then the subscriber list after the
// members-first window. The unsubscribe link is a working tokened
// opt-out, same as the club follow-up.

export default function ReleaseEmail({ model }: { model: ReleaseEmailModel }) {
  return (
    <EmailLayout preview={`${model.bookTitle} has arrived on the ${model.shelfLabel} shelf`}>
      <Text style={styles.heading}>
        {model.wave === "club" ? "Members first: a new book is here" : "A new book has arrived"}
      </Text>
      <Text style={styles.paragraph}>
        {model.wave === "club"
          ? `Book Club members hear about every new book first, and this one is yours before anyone else: ${model.bookTitle} has arrived on the shelf.`
          : `A new book has arrived on the Big Brain Shelf: ${model.bookTitle}.`}
      </Text>
      {model.coverUrl ? (
        <Section style={{ margin: "4px 0 16px" }}>
          <Img
            src={model.coverUrl}
            alt={`${model.bookTitle} cover`}
            width="220"
            style={{ borderRadius: "8px", border: `1px solid ${BRAND.line}` }}
          />
        </Section>
      ) : null}
      {model.description ? <Text style={styles.paragraph}>{model.description}</Text> : null}
      <Text style={styles.paragraph}>
        Find it on the {model.shelfLabel} shelf
        {model.publishedLabel ? `, published ${model.publishedLabel}` : ""}.
        {model.priceLine ? ` ${model.priceLine}.` : ""}
      </Text>
      <Section style={{ margin: "4px 0 20px" }}>
        <Button
          href={model.bookUrl}
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
          See the book
        </Button>
      </Section>
      {model.cast.length ? (
        <>
          <Text style={styles.sectionHeading}>Meet the cast</Text>
          {model.cast.map((c) => (
            <Section key={c.name} style={{ margin: "0 0 12px" }}>
              {c.portrait ? (
                <Img
                  src={c.portrait}
                  alt={c.name}
                  width="72"
                  height="72"
                  style={{
                    borderRadius: "8px",
                    border: `1px solid ${BRAND.line}`,
                    display: "inline-block",
                    verticalAlign: "middle",
                  }}
                />
              ) : null}
              <Text
                style={{
                  ...styles.paragraph,
                  display: "inline-block",
                  verticalAlign: "middle",
                  margin: "0 0 0 12px",
                }}
              >
                {c.debut
                  ? `Introducing ${c.name}, the ${c.species}${c.role ? `: ${c.role}` : ""}.`
                  : `${c.name}, the ${c.species}, is back${c.role ? `: ${c.role}` : ""}.`}
              </Text>
            </Section>
          ))}
        </>
      ) : null}
      <Text style={styles.paragraph}>
        Happy reading,
        <br />
        Big Brain Shelf
      </Text>
      <Text style={styles.muted}>
        {model.wave === "club"
          ? "You are getting this because you are a Big Brain Shelf Book Club member. "
          : "You are getting this because you subscribed at bigbrainshelf.com. "}
        Rather not get release news?{" "}
        <Link href={model.unsubscribeUrl} style={{ color: BRAND.navy, textDecoration: "underline" }}>
          Unsubscribe here
        </Link>
        .
      </Text>
    </EmailLayout>
  );
}

import React from "react";
import { Button, Section, Text } from "@react-email/components";
import { BRAND, EmailLayout, styles } from "./EmailLayout";
import type { DelayEmailModel } from "../src/lib/delay-emails";

// Running-late apology for a printed order or a Book Club box that
// missed its promised ship-by date. Renders the same words and facts
// as buildDelayEmailText's plain text; both come from the model in
// src/lib/delay-emails.ts. One call to action: Track your order.

export default function DelayEmail({ model }: { model: DelayEmailModel }) {
  return (
    <EmailLayout preview={model.heading}>
      <Text style={styles.heading}>{model.heading}</Text>
      <Text style={styles.paragraph}>{model.intro}</Text>
      {model.lateItems.map((title) => (
        <Text key={title} style={styles.listItem}>
          {"• "}
          {title}
        </Text>
      ))}
      <Text style={{ ...styles.paragraph, marginTop: "16px" }}>{model.expectedLine}</Text>
      <Text style={styles.paragraph}>{model.promoLine}</Text>
      <Section style={{ margin: "4px 0 20px" }}>
        <Button
          href={model.trackUrl}
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
          {model.trackLabel}
        </Button>
      </Section>
      <Text style={styles.paragraph}>
        Happy reading,
        <br />
        Big Brain Shelf
      </Text>
    </EmailLayout>
  );
}

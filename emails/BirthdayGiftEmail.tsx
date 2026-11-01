import React from "react";
import { Button, Section, Text } from "@react-email/components";
import { BRAND, EmailLayout, styles } from "./EmailLayout";

export interface BirthdayGiftEmailModel {
  preview: string;
  heading: string;
  paragraphs: string[];
  giftUrl: string;
  footnote?: string | null;
}

export default function BirthdayGiftEmail({
  model,
}: {
  model: BirthdayGiftEmailModel;
}) {
  return (
    <EmailLayout preview={model.preview}>
      <Text style={styles.heading}>{model.heading}</Text>
      {model.paragraphs.map((p, i) => (
        <Text key={i} style={styles.paragraph}>
          {p}
        </Text>
      ))}
      <Section
        style={{
          backgroundColor: "#fff7ed",
          border: `1px solid ${BRAND.orange}`,
          borderRadius: "10px",
          padding: "16px 20px",
          margin: "18px 0 20px",
        }}
      >
        <Text
          style={{
            color: BRAND.navy,
            fontSize: "15px",
            fontWeight: 700,
            margin: "0 0 6px",
          }}
        >
          Your Birthday Shelf Surprise Inside:
        </Text>
        <Text style={{ ...styles.paragraph, margin: 0, fontSize: "14px" }}>
          Open your family shelf to unlock your birthday printable coloring pack, start Read-Along Theater mode in full color, and claim your $10 birthday book credit on your next Gift Set.
        </Text>
      </Section>
      <Section style={{ margin: "20px 0 16px" }}>
        <Button
          href={model.giftUrl}
          style={{
            backgroundColor: BRAND.navy,
            color: "#ffffff",
            fontSize: "15px",
            fontWeight: 700,
            padding: "12px 22px",
            borderRadius: "8px",
            textDecoration: "none",
            boxSizing: "border-box",
          }}
        >
          Open your birthday gift
        </Button>
      </Section>
      {model.footnote && <Text style={styles.muted}>{model.footnote}</Text>}
    </EmailLayout>
  );
}

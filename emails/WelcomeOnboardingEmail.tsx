import React from "react";
import { Button, Section, Text } from "@react-email/components";
import { BRAND, EmailLayout, styles } from "./EmailLayout";

export interface WelcomeOnboardingEmailModel {
  preview: string;
  heading: string;
  paragraphs: string[];
  accountUrl: string;
  footnote?: string | null;
}

export default function WelcomeOnboardingEmail({
  model,
}: {
  model: WelcomeOnboardingEmailModel;
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
          backgroundColor: "#faf9f7",
          border: `1px solid ${BRAND.line}`,
          borderRadius: "10px",
          padding: "16px 20px",
          margin: "18px 0 20px",
        }}
      >
        <Text
          style={{
            color: BRAND.navy,
            fontSize: "14px",
            fontWeight: 700,
            margin: "0 0 8px",
          }}
        >
          Three quick ways to start tonight:
        </Text>
        <Text style={{ ...styles.paragraph, margin: "0 0 6px", fontSize: "14px" }}>
          1. Open the Book Viewer in your account to flip between the storybook, coloring edition, and full-color artwork.
        </Text>
        <Text style={{ ...styles.paragraph, margin: "0 0 6px", fontSize: "14px" }}>
          2. Tap Play in the bottom Audio Dock so the narrator reads along while pages stay in sync.
        </Text>
        <Text style={{ ...styles.paragraph, margin: 0, fontSize: "14px" }}>
          3. Set the Sleep Timer to 60 minutes (or End of chapter) so playback turns off gently on its own.
        </Text>
      </Section>
      <Section style={{ margin: "20px 0 16px" }}>
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
            boxSizing: "border-box",
          }}
        >
          Open your family shelf
        </Button>
      </Section>
      {model.footnote && <Text style={styles.muted}>{model.footnote}</Text>}
    </EmailLayout>
  );
}

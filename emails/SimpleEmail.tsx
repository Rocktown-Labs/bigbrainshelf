import React from "react";
import { Button, Section, Text } from "@react-email/components";
import { BRAND, EmailLayout, styles } from "./EmailLayout";

// The generic branded email for one-off kinds that have no
// dedicated template (contact form forwards, sign-in links):
// a heading, plain paragraphs, and an optional button. Keeps
// every email the store sends inside the same shell instead of
// falling back to bare plain text.

export interface SimpleEmailModel {
  preview: string;
  heading: string;
  paragraphs: string[];
  button?: { label: string; href: string } | null;
  footnote?: string | null;
}

export default function SimpleEmail({ model }: { model: SimpleEmailModel }) {
  return (
    <EmailLayout preview={model.preview}>
      <Text style={styles.heading}>{model.heading}</Text>
      {model.paragraphs.map((p, i) => (
        <Text key={i} style={styles.paragraph}>{p}</Text>
      ))}
      {model.button && (
        <Section style={{ margin: "20px 0 16px" }}>
          <Button
            href={model.button.href}
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
            {model.button.label}
          </Button>
        </Section>
      )}
      {model.footnote && <Text style={styles.muted}>{model.footnote}</Text>}
    </EmailLayout>
  );
}

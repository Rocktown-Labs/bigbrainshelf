import React from "react";
import { Button, Section, Text } from "@react-email/components";
import { BRAND, EmailLayout, styles } from "./EmailLayout";
import type { PrintParcelEmailModel } from "../src/lib/print-fulfillment";

// Lulu print parcel update (print_shipped / print_delivered): one
// email per parcel, rendered from the same model that builds the
// stored plain text (buildPrintParcelEmailModel in
// lib/print-fulfillment). The tracking block shows while the parcel
// travels; the one button is the tracking page on the shipped email
// and the library on the delivered email.

export default function PrintParcelEmail({
  model,
}: {
  model: PrintParcelEmailModel;
}) {
  return (
    <EmailLayout preview={model.headline}>
      <Text style={styles.heading}>{model.headline}</Text>
      {model.titles.map((title) => (
        <Text key={title} style={styles.listItem}>
          {"• "}
          {title}
        </Text>
      ))}
      <Text style={{ ...styles.paragraph, marginTop: "16px" }}>{model.body}</Text>
      {model.trackingNumber && (
        <Text style={styles.paragraph}>
          {model.carrier ? <>Carrier: {model.carrier}<br /></> : null}
          Tracking number: {model.trackingNumber}
        </Text>
      )}
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
      <Text style={styles.paragraph}>Big Brain Shelf</Text>
    </EmailLayout>
  );
}

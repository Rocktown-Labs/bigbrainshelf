import React from "react";
import { Text } from "@react-email/components";
import { BRAND, EmailLayout, styles } from "./EmailLayout";
import type { PhysicalEmailModel } from "../src/lib/orders";

// Printed pre-order status update (in_print / shipped / delivered).
// Renders the same headline, titles, and body as buildPhysicalUpdateEmail's
// plain text; both come from buildPhysicalUpdateEmailModel.

export default function PhysicalUpdateEmail({
  model,
}: {
  model: PhysicalEmailModel;
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
      <Text style={styles.paragraph}>Big Brain Shelf</Text>
    </EmailLayout>
  );
}

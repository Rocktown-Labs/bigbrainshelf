import React from "react";
import { Button, Section, Text } from "@react-email/components";
import { BRAND, EmailLayout, styles } from "./EmailLayout";

// The owner's new-order email (CG, 2026-10-31: the old one was
// unstyled plain text and said nothing clean about the order).
// A proper summary: every item with its format and price, the
// shipping, the total, the buyer, the ship-to for printed
// orders, and one button into the admin order page.

export interface OwnerOrderEmailModel {
  orderShortId: string;
  total: string;
  itemCount: number;
  lines: { title: string; formatLabel: string; price: string }[];
  shipping: string | null;
  buyerEmail: string;
  shipName: string | null;
  shipAddress: string | null;
  adminUrl: string;
}

export default function OwnerOrderEmail({ model }: { model: OwnerOrderEmailModel }) {
  return (
    <EmailLayout preview={`New order #${model.orderShortId}: ${model.total}`}>
      <Text style={styles.heading}>New order #{model.orderShortId}</Text>
      <Text style={styles.paragraph}>
        {model.itemCount} {model.itemCount === 1 ? "item" : "items"} · <strong>{model.total}</strong>
      </Text>

      <Section style={{ borderTop: `1px solid ${BRAND.line}`, marginTop: "8px" }}>
        {model.lines.map((l, i) => (
          <Text key={i} style={{ ...styles.listItem, margin: "10px 0 2px" }}>
            <strong>{l.title}</strong>
            <span style={{ color: BRAND.muted }}> · {l.formatLabel}</span>
            <span style={{ float: "right" }}>{l.price}</span>
          </Text>
        ))}
        {model.shipping && (
          <Text style={{ ...styles.listItem, margin: "10px 0 2px" }}>
            Shipping
            <span style={{ float: "right" }}>{model.shipping}</span>
          </Text>
        )}
        <Text
          style={{
            ...styles.listItem,
            borderTop: `1px solid ${BRAND.line}`,
            paddingTop: "10px",
            margin: "10px 0 2px",
            fontWeight: 700,
          }}
        >
          Total charged
          <span style={{ float: "right" }}>{model.total}</span>
        </Text>
      </Section>

      <Text style={styles.sectionHeading}>Buyer</Text>
      <Text style={styles.paragraph}>{model.buyerEmail}</Text>

      {model.shipAddress && (
        <>
          <Text style={styles.sectionHeading}>Ship to</Text>
          <Text style={styles.paragraph}>
            {model.shipName ? <>{model.shipName}<br /></> : null}
            {model.shipAddress}
          </Text>
        </>
      )}

      <Section style={{ margin: "24px 0 16px" }}>
        <Button
          href={model.adminUrl}
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
          Open the order
        </Button>
      </Section>
    </EmailLayout>
  );
}

import React from "react";
import { Button, Column, Row, Section, Text } from "@react-email/components";
import { BRAND, EmailLayout, styles } from "./EmailLayout";

// Prices sit in their own right-aligned table cell. The old layout
// floated the price inside the item paragraph, and email clients
// dropped it onto the next line (or against the wrong row) whenever
// the title wrapped: CG's screenshots, 2026-10-31. Tables are the
// only layout email clients align reliably.

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
  promo: { code: string; amount: string } | null;
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
          <Row key={i}>
            <Column style={{ verticalAlign: "top", padding: "8px 12px 2px 0" }}>
              <Text style={{ ...styles.listItem, margin: 0 }}>
                <strong>{l.title}</strong>
                <span style={{ color: BRAND.muted }}> · {l.formatLabel}</span>
              </Text>
            </Column>
            <Column
              style={{
                verticalAlign: "top",
                textAlign: "right",
                whiteSpace: "nowrap",
                width: "96px",
                padding: "8px 0 2px",
              }}
            >
              <Text style={{ ...styles.listItem, margin: 0 }}>{l.price}</Text>
            </Column>
          </Row>
        ))}
        {model.shipping && (
          <Row>
            <Column style={{ verticalAlign: "top", padding: "8px 12px 2px 0" }}>
              <Text style={{ ...styles.listItem, margin: 0 }}>Shipping</Text>
            </Column>
            <Column
              style={{
                verticalAlign: "top",
                textAlign: "right",
                whiteSpace: "nowrap",
                width: "96px",
                padding: "8px 0 2px",
              }}
            >
              <Text style={{ ...styles.listItem, margin: 0 }}>{model.shipping}</Text>
            </Column>
          </Row>
        )}
        {model.promo && (
          <Row>
            <Column style={{ verticalAlign: "top", padding: "8px 12px 2px 0" }}>
              <Text style={{ ...styles.listItem, margin: 0 }}>Promo {model.promo.code}</Text>
            </Column>
            <Column
              style={{
                verticalAlign: "top",
                textAlign: "right",
                whiteSpace: "nowrap",
                width: "96px",
                padding: "8px 0 2px",
              }}
            >
              <Text style={{ ...styles.listItem, margin: 0 }}>-{model.promo.amount}</Text>
            </Column>
          </Row>
        )}
        <Row>
          <Column
            style={{
              verticalAlign: "top",
              padding: "10px 12px 2px 0",
              borderTop: `1px solid ${BRAND.line}`,
            }}
          >
            <Text style={{ ...styles.listItem, margin: 0, fontWeight: 700 }}>
              Total charged
            </Text>
          </Column>
          <Column
            style={{
              verticalAlign: "top",
              textAlign: "right",
              whiteSpace: "nowrap",
              width: "96px",
              padding: "10px 0 2px",
              borderTop: `1px solid ${BRAND.line}`,
            }}
          >
            <Text style={{ ...styles.listItem, margin: 0, fontWeight: 700 }}>
              {model.total}
            </Text>
          </Column>
        </Row>
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

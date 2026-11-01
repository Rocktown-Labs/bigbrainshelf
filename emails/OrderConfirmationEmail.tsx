import React from "react";
import { Button, Column, Link, Row, Section, Text } from "@react-email/components";
import { BRAND, EmailLayout, styles } from "./EmailLayout";
import type { ConfirmationEmailModel } from "../src/lib/orders";

// Order confirmation: the one email that carries the buyer's download
// links. Renders the same facts as buildConfirmationEmail's plain text
// (both come from buildConfirmationEmailModel), dressed in the store's
// brand. The stored outbox body_text remains the plain-text part.

export default function OrderConfirmationEmail({
  model,
}: {
  model: ConfirmationEmailModel;
}) {
  return (
    <EmailLayout preview="Your Big Brain Shelf books are ready to download">
      <Text style={styles.heading}>Your order is ready</Text>
      <Text style={styles.paragraph}>
        Thank you for your order from Big Brain Shelf. Here is what you got:
      </Text>
      {/* Itemized receipt: every line priced in its own right-aligned
          table cell (never floated, email clients drop floats onto the
          wrong row), so the lines visibly add up to the total. */}
      <Section style={{ margin: "4px 0 12px" }}>
        {model.items.map((item) => (
          <Row key={item.title + item.formatLabel}>
            <Column style={{ verticalAlign: "top", padding: "4px 12px 2px 0" }}>
              <Text style={{ ...styles.listItem, margin: 0 }}>
                {item.title}{" "}
                <span style={{ color: BRAND.muted }}>({item.formatLabel})</span>
                {item.qty > 1 ? <span style={{ fontWeight: 700 }}> ×{item.qty}</span> : null}
              </Text>
            </Column>
            <Column
              style={{
                verticalAlign: "top",
                textAlign: "right",
                whiteSpace: "nowrap",
                width: "96px",
                padding: "4px 0 2px",
              }}
            >
              <Text style={{ ...styles.listItem, margin: 0 }}>
                {`$${(item.lineTotalCents / 100).toFixed(2)}`}
              </Text>
            </Column>
          </Row>
        ))}
        {model.shipping && (
          <Row>
            <Column style={{ verticalAlign: "top", padding: "4px 12px 2px 0" }}>
              <Text style={{ ...styles.listItem, margin: 0 }}>
                Shipping{" "}
                <span style={{ color: BRAND.muted }}>
                  ({[model.shipping.carrier, model.shipping.service].filter(Boolean).join(" ")})
                </span>
              </Text>
            </Column>
            <Column
              style={{
                verticalAlign: "top",
                textAlign: "right",
                whiteSpace: "nowrap",
                width: "96px",
                padding: "4px 0 2px",
              }}
            >
              <Text style={{ ...styles.listItem, margin: 0 }}>
                {`$${(model.shipping.cents / 100).toFixed(2)}`}
              </Text>
            </Column>
          </Row>
        )}
        {model.totalCents > 0 && (
          <Row>
            <Column
              style={{
                verticalAlign: "top",
                padding: "8px 12px 0 0",
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
                padding: "8px 0 0",
                borderTop: `1px solid ${BRAND.line}`,
              }}
            >
              <Text style={{ ...styles.listItem, margin: 0, fontWeight: 700 }}>
                {`$${(model.totalCents / 100).toFixed(2)}`}
              </Text>
            </Column>
          </Row>
        )}
      </Section>

      <Text style={styles.sectionHeading}>Your books are in your library</Text>
      {model.downloads.map((book) => (
        <Section key={book.title} style={{ margin: "0 0 16px" }}>
          <Text
            style={{
              color: BRAND.ink,
              fontSize: "15px",
              fontWeight: 700,
              margin: "0 0 6px",
            }}
          >
            {book.title}
          </Text>
          {book.links.map((link) => (
            <Text key={link.label} style={{ margin: "0 0 6px" }}>
              <Link
                href={link.url}
                style={{
                  color: BRAND.navy,
                  fontSize: "15px",
                  fontWeight: 600,
                  textDecoration: "underline",
                }}
              >
                {link.label}
              </Link>
            </Text>
          ))}
        </Section>
      ))}

      <Text style={styles.paragraph}>
        Sign in with the email address you used at checkout and your books
        are waiting for you, on any device:
      </Text>
      {model.guest && (
        <Text style={styles.paragraph}>
          We also sent you a one-click sign-in link in a separate email, so
          you do not need a password.
        </Text>
      )}
      <Section style={{ margin: "4px 0 20px" }}>
        <Button
          href={model.libraryUrl}
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
          Open your library
        </Button>
      </Section>

      {model.printed && model.giftsetOnly && (
        <>
          <Text style={styles.sectionHeading}>About your gift set</Text>
          <Text style={styles.paragraph}>
            Your gift set is being made: the printed storybook and the
            printed coloring book are prepared together. We will email you
            when it is being printed, when it ships, and when it is
            delivered. The digital files above are yours to enjoy right
            away.
          </Text>
        </>
      )}

      {model.printed && !model.giftsetOnly && (
        <>
          <Text style={styles.sectionHeading}>About your printed book</Text>
          <Text style={styles.paragraph}>
            Your printed book is being made. We will email you when it is
            being printed, when it ships, and when it is delivered. The
            digital files above are yours to enjoy right away.
          </Text>
        </>
      )}

      {model.club && (
        <>
          <Text style={styles.sectionHeading}>About the Book Club</Text>
          <Text style={styles.paragraph}>
            Members of the Big Brain Shelf Book Club get the club book
            as a full gift set (the printed storybook plus its printed
            coloring book) and a second printed book from the back catalog
            in each box, plus a sticker sheet and a little extra from the
            cast, and the digital editions in their library from day one.
            Membership is {model.club.priceLabel} every 3 months, shipping
            included, or {model.club.annualLabel} a year, with your price
            locked while the membership stays active. Your first box
            would be due the day you join, and a new box follows every 3
            months from your join date.
          </Text>
          <Text style={styles.paragraph}>
            Rather just listen? The Audio Club puts every Big Brain Shelf
            audiobook in your library for {model.club.audioMonthlyLabel} a
            month, or {model.club.audioAnnualLabel} a year, for as long as
            your membership is active. Listening only: nothing ships on
            that plan.
          </Text>
          <Text style={styles.paragraph}>
            <Link
              href={model.club.url}
              style={{
                color: BRAND.navy,
                fontSize: "15px",
                fontWeight: 600,
                textDecoration: "underline",
              }}
            >
              Join the club
            </Link>
          </Text>
        </>
      )}

      <Text style={styles.paragraph}>
        Happy reading,
        <br />
        Big Brain Shelf
      </Text>
    </EmailLayout>
  );
}

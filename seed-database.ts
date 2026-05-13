/**
 * Database seeding script – Holiday Booking Data
 *
 * Populates two collections:
 *   1. holiday_db.hotels           – 20 synthetic hotel / accommodation records
 *   2. holiday_db.travel_policies  – 8 travel booking policy documents
 *
 * Documents are stored with a `pageContent` text field. Atlas Vector Search
 * auto-embedding (voyage-4) generates vectors server-side – no Voyage AI API
 * key or manual embedding step required.
 *
 * Run with:  npm run seed
 *
 * Vector Search indexes are created by Terraform (terraform/vector_search.tf)
 * and are configured with autoEmbed on the `pageContent` field.
 */

import { ChatOpenAI } from "@langchain/openai";
import { MongoClient } from "mongodb";
import { z } from "zod";
import { DB_NAMES, COLLECTIONS } from "./shared/utils";
import "dotenv/config";

// ─── Hotel schema ─────────────────────────────────────────────────────────────

const HotelSchema = z.object({
  hotel_id: z.string(),
  name: z.string(),
  city: z.string(),
  country: z.string(),
  country_code: z.string().length(2).describe("ISO 3166-1 alpha-2"),
  region: z.string().describe("e.g. Côte d'Azur, Scottish Highlands, Algarve"),
  address: z.string(),
  star_rating: z.number().int().min(1).max(5),
  property_type: z.enum(["hotel", "resort", "boutique_hotel", "villa", "apartment", "hostel"]),
  room_types: z.array(z.object({
    type: z.enum(["standard", "deluxe", "suite", "family", "penthouse"]),
    max_occupancy: z.number().int(),
    price_per_night: z.number(),
    currency: z.string(),
    breakfast_included: z.boolean(),
    refundable: z.boolean(),
    cancellation_deadline_days: z.number().int().nullable(),
  })),
  amenities: z.array(z.string()).describe("e.g. pool, spa, gym, free wifi, restaurant"),
  check_in_time: z.string().describe("e.g. 15:00"),
  check_out_time: z.string().describe("e.g. 11:00"),
  availability: z.object({
    available_from: z.string().describe("ISO date"),
    available_until: z.string().describe("ISO date"),
    rooms_available: z.number().int().min(0),
  }),
  rating: z.object({
    score: z.number().min(1).max(10),
    review_count: z.number().int(),
  }),
  distance_to_centre_km: z.number(),
  notes: z.string().describe("2-3 sentences describing the property and its highlights"),
});

type Hotel = z.infer<typeof HotelSchema>;

// ─── Policy schema ────────────────────────────────────────────────────────────

const PolicySchema = z.object({
  policy_id: z.string(),
  title: z.string(),
  category: z.enum([
    "booking",
    "cancellation",
    "payment",
    "child_policy",
    "pet_policy",
    "accessibility",
    "data_protection",
    "travel_insurance",
  ]),
  content: z.string().describe("4-6 sentence policy description with specific rules and conditions"),
  applies_to: z.array(z.string()).describe("e.g. ['all_properties', 'resorts', 'apartments']"),
  effective_date: z.string(),
  last_updated: z.string(),
  version: z.string(),
});

type Policy = z.infer<typeof PolicySchema>;

// ─── LLM ─────────────────────────────────────────────────────────────────────

const llm = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.7 });

// ─── Generate hotels ──────────────────────────────────────────────────────────

async function generateHotels(): Promise<Hotel[]> {
  const structuredModel = llm.withStructuredOutput(
    z.object({ hotels: z.array(HotelSchema) })
  );

  console.log("Generating synthetic hotel / accommodation data...");

  const result = await structuredModel.invoke(
    `Generate 20 realistic hotel and accommodation records for popular European holiday destinations.
Include a variety of:
- Destinations: Barcelona, Paris, Santorini (Greece), Algarve (Portugal), Amalfi Coast (Italy), 
  Scottish Highlands, Côte d'Azur (France), Dubrovnik (Croatia), Mallorca (Spain), Amsterdam (Netherlands)
- Property types: mix of hotel, resort, boutique_hotel, villa, apartment
- Star ratings: 2 to 5 stars
- Room types: each hotel should have 2-4 room types with realistic prices
  (budget €60/night to luxury €1200/night)
- Some rooms refundable, some non-refundable
- Amenities appropriate to the property type and star rating
- Availability windows between 2026-06-01 and 2026-12-31
- Realistic TripAdvisor-style review scores (6.5 to 9.8) and review counts
- Distances from city centre (0.1 km to 8 km)

Use realistic hotel names and full street addresses. Include notable highlights in the notes field.`
  );

  return result.hotels;
}

function buildHotelSummary(h: Hotel): string {
  const cheapestRoom = h.room_types.reduce(
    (min, r) => (r.price_per_night < min.price_per_night ? r : min),
    h.room_types[0]
  );
  return [
    `${h.name} – a ${h.star_rating}-star ${h.property_type.replace("_", " ")} in ${h.city}, ${h.country}.`,
    `Located in ${h.region}, ${h.distance_to_centre_km}km from the city centre.`,
    `Rooms from ${cheapestRoom.currency} ${cheapestRoom.price_per_night}/night.`,
    `Amenities: ${h.amenities.slice(0, 5).join(", ")}.`,
    `Check-in: ${h.check_in_time}, check-out: ${h.check_out_time}.`,
    `Rating: ${h.rating.score}/10 (${h.rating.review_count} reviews).`,
    `Availability: ${h.availability.rooms_available} rooms available until ${h.availability.available_until}.`,
    h.notes,
  ].join(" ");
}

// ─── Generate policies ────────────────────────────────────────────────────────

async function generatePolicies(): Promise<Policy[]> {
  const structuredModel = llm.withStructuredOutput(
    z.object({ policies: z.array(PolicySchema) })
  );

  console.log("Generating travel booking policy documents...");

  const result = await structuredModel.invoke(
    `Generate 8 realistic travel platform internal policy documents covering:
1. Booking window policy – how far in advance bookings can be made/modified, lead-time rules
2. Cancellation and refund policy – free cancellation window, fees by property type and notice period
3. Payment terms policy – accepted payment methods, deposit requirements, when full payment is due
4. Child policy – age definitions, extra bed charges, age restrictions for specific property types
5. Pet policy – pet-friendly properties, breed/size restrictions, pet fees and liability
6. Accessibility policy – WCAG compliance, accessible room booking process, service animal rules
7. Traveller data protection policy – GDPR/CCPA compliance, data retention, consent requirements
8. Travel insurance recommendation policy – mandatory vs optional insurance, coverage requirements for certain destinations

Each policy should be detailed (5-7 sentences), use professional travel industry terminology,
reference specific timeframes and conditions. Effective dates should be in 2025-2026.`
  );

  return result.policies;
}

// ─── Seed hotels ──────────────────────────────────────────────────────────────

async function seedHotels(client: MongoClient): Promise<void> {
  const collection = client.db(DB_NAMES.HOLIDAY).collection(COLLECTIONS.HOTELS);
  await collection.deleteMany({});

  const hotels = await generateHotels();
  const summaries = hotels.map(buildHotelSummary);

  // Atlas auto-embedding generates vectors server-side from `pageContent`.
  const docs = hotels.map((hotel, i) => ({
    pageContent: summaries[i],
    metadata: { ...hotel },
  }));

  const result = await collection.insertMany(docs);
  console.log(`✓ Inserted ${result.insertedCount} hotel records (Atlas will auto-embed pageContent).`);
}

// ─── Seed policies ────────────────────────────────────────────────────────────

async function seedPolicies(client: MongoClient): Promise<void> {
  const collection = client.db(DB_NAMES.HOLIDAY).collection(COLLECTIONS.POLICIES);
  await collection.deleteMany({});

  const policies = await generatePolicies();
  const contents = policies.map((p) => `${p.title}: ${p.content}`);

  // Atlas auto-embedding generates vectors server-side from `pageContent`.
  const docs = policies.map((policy, i) => ({
    pageContent: contents[i],
    metadata: { ...policy },
  }));

  const result = await collection.insertMany(docs);
  console.log(`✓ Inserted ${result.insertedCount} policy documents (Atlas will auto-embed pageContent).`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI as string);

  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB.\n");

    await seedHotels(client);
    await seedPolicies(client);

    // Ensure long_term_memory collection exists so Terraform can create the
    // memory_vector_index against it. MongoDBStore.start() would normally
    // create it at runtime, but the Terraform index resource runs before the
    // app has ever started. createCollection is a no-op if it already exists.
    await client
      .db(DB_NAMES.MEMORY)
      .createCollection(COLLECTIONS.LONG_TERM_MEMORY)
      .catch(() => {}); // already exists → ignore
    console.log(`✓ Ensured ${DB_NAMES.MEMORY}.${COLLECTIONS.LONG_TERM_MEMORY} collection exists.`);

    console.log("\n✓ Seeding complete!");
    console.log("Atlas will auto-generate embeddings for all inserted documents using voyage-4.");
    console.log("Vector Search indexes (Terraform) must be active before querying.");
  } catch (err) {
    console.error("Seeding failed:", err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();


/**
 * Read-only Stripe/Mongo subscription lookup.
 *
 * Usage:
 *   node scripts/lookup-stripe-package-purchases.js
 *   node scripts/lookup-stripe-package-purchases.js --since=2026-06-17
 *   node scripts/lookup-stripe-package-purchases.js --subscription=sub_...
 *   node scripts/lookup-stripe-package-purchases.js --fix-target
 */

require('dotenv').config();

const mongoose = require('mongoose');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User');

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, ...value] = arg.replace(/^--/, '').split('=');
        return [key, value.join('=') || true];
    })
);

const target = {
    subscriptionId: args.subscription || 'sub_1TjHudCd6gxWUimRWYQ6KXPs',
    chargeId: args.charge || 'ch_3TjHueCd6gxWUimR1aQnoNmc',
    paymentIntentId: args.payment_intent || 'pi_3TjHueCd6gxWUimR17BkJnfd',
    invoiceNumber: args.invoice_number || 'US24HWFG-0001',
    since: args.since || '2026-06-17'
};

const priceToPlan = (priceId) => {
    const mapping = {
        [process.env.STRIPE_PRICE_STARTER]: 'starter',
        [process.env.STRIPE_PRICE_PRO]: 'pro',
        [process.env.STRIPE_PRICE_PREMIUM]: 'premium',
        [process.env.STRIPE_PRICE_ELITE]: 'elite',
        price_1SfTvNCd6gxWUimRapg2v7zC: 'starter',
        price_1SfTxUCd6gxWUimRfpe40Nr2: 'pro',
        price_1SfU0WCd6gxWUimRjjA8XnFr: 'premium',
        price_1SfU1VCd6gxWUimReOuVaFb4: 'elite',
        price_1SfTvNCd6gxWUimR5g3pUz9g: 'starter',
        price_1SfTxUCd6gxWUimRDKXxf5B9: 'pro',
        price_1SfU0WCd6gxWUimRj1tdL545: 'premium',
        price_1SfU1VCd6gxWUimR0tUeO70P: 'elite'
    };

    return mapping[priceId] || 'unknown';
};

const fmtDate = (timestamp) => timestamp ? new Date(timestamp * 1000).toISOString() : null;
const dollars = (amount) => typeof amount === 'number' ? `$${(amount / 100).toFixed(2)}` : null;

const summarizeSubscription = (sub) => {
    const item = sub?.items?.data?.[0];
    const price = item?.price;
    return {
        id: sub.id,
        status: sub.status,
        customer: sub.customer,
        created: fmtDate(sub.created),
        currentPeriodStart: fmtDate(sub.current_period_start),
        currentPeriodEnd: fmtDate(sub.current_period_end),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        priceId: price?.id,
        plan: priceToPlan(price?.id),
        interval: price?.recurring?.interval,
        amount: dollars(price?.unit_amount),
        product: price?.product
    };
};

const printJson = (label, value) => {
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(value, null, 2));
};

async function findMongoUsers({ customerId, subscriptionId, email, metadataUserId }) {
    const or = [];

    if (customerId) or.push({ 'subscription.stripeCustomerId': customerId });
    if (subscriptionId) or.push({ 'subscription.stripeSubscriptionId': subscriptionId });
    if (metadataUserId && mongoose.Types.ObjectId.isValid(metadataUserId)) or.push({ _id: metadataUserId });
    if (email) or.push({ email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });

    if (or.length === 0) return [];

    return User.find({ $or: or })
        .select('email username name subscription createdAt date')
        .lean();
}

async function main() {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
    if (!process.env.MONGODB_URI && !process.env.MONGO_URI) throw new Error('MONGODB_URI/MONGO_URI is not configured');

    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

    let subscription = null;
    let charge = null;
    let paymentIntent = null;
    let invoice = null;
    let customer = null;

    if (target.subscriptionId) {
        subscription = await stripe.subscriptions.retrieve(target.subscriptionId, {
            expand: ['customer', 'latest_invoice', 'items.data.price.product']
        });
        printJson('Target Subscription', summarizeSubscription(subscription));
    }

    if (target.chargeId) {
        charge = await stripe.charges.retrieve(target.chargeId, {
            expand: ['customer', 'invoice', 'payment_intent']
        });
        printJson('Target Charge', {
            id: charge.id,
            paid: charge.paid,
            status: charge.status,
            amount: dollars(charge.amount),
            created: fmtDate(charge.created),
            customer: charge.customer?.id || charge.customer,
            customerEmail: charge.billing_details?.email || charge.customer?.email,
            receiptEmail: charge.receipt_email,
            invoice: charge.invoice?.id || charge.invoice,
            invoiceNumber: charge.invoice?.number,
            paymentIntent: charge.payment_intent?.id || charge.payment_intent
        });
    }

    if (target.paymentIntentId) {
        paymentIntent = await stripe.paymentIntents.retrieve(target.paymentIntentId, {
            expand: ['customer', 'invoice']
        });
        printJson('Target Payment Intent', {
            id: paymentIntent.id,
            status: paymentIntent.status,
            amount: dollars(paymentIntent.amount),
            created: fmtDate(paymentIntent.created),
            customer: paymentIntent.customer?.id || paymentIntent.customer,
            invoice: paymentIntent.invoice?.id || paymentIntent.invoice,
            metadata: paymentIntent.metadata
        });
    }

    invoice = subscription?.latest_invoice || charge?.invoice || paymentIntent?.invoice || null;
    if (!invoice && target.invoiceNumber) {
        const invoices = await stripe.invoices.search({
            query: `number:"${target.invoiceNumber}"`,
            limit: 1
        });
        invoice = invoices.data[0] || null;
    }

    if (typeof invoice === 'string') {
        invoice = await stripe.invoices.retrieve(invoice, { expand: ['customer', 'subscription'] });
    }

    if (invoice) {
        printJson('Target Invoice', {
            id: invoice.id,
            number: invoice.number,
            status: invoice.status,
            paid: invoice.paid,
            amountPaid: dollars(invoice.amount_paid),
            created: fmtDate(invoice.created),
            customer: invoice.customer?.id || invoice.customer,
            customerEmail: invoice.customer_email || invoice.customer?.email,
            subscription: invoice.subscription?.id || invoice.subscription
        });
    }

    customer = subscription?.customer || charge?.customer || paymentIntent?.customer || invoice?.customer || null;
    if (typeof customer === 'string') {
        customer = await stripe.customers.retrieve(customer);
    }

    if (customer) {
        printJson('Target Customer', {
            id: customer.id,
            email: customer.email,
            name: customer.name,
            created: fmtDate(customer.created),
            metadata: customer.metadata
        });
    }

    const mongoUsers = await findMongoUsers({
        customerId: customer?.id || subscription?.customer,
        subscriptionId: subscription?.id || target.subscriptionId,
        email: customer?.email || charge?.billing_details?.email || invoice?.customer_email,
        metadataUserId: customer?.metadata?.userId || subscription?.metadata?.userId || paymentIntent?.metadata?.userId
    });
    printJson('Matching Mongo Users', mongoUsers);

    if (args['fix-target']) {
        if (!subscription) throw new Error('--fix-target requires a target subscription');
        if (subscription.status !== 'active') throw new Error(`Target subscription is not active: ${subscription.status}`);

        const user = mongoUsers.find((candidate) =>
            candidate._id?.toString() === customer?.metadata?.userId ||
            candidate.subscription?.stripeCustomerId === customer?.id ||
            candidate.email?.toLowerCase() === customer?.email?.toLowerCase()
        );

        if (!user) throw new Error('No Mongo user found to update');

        const priceId = subscription.items.data[0]?.price?.id;
        const plan = priceToPlan(priceId);
        if (plan === 'unknown') throw new Error(`Unknown Stripe price ID: ${priceId}`);

        const before = user.subscription || {};
        const updatedUser = await User.findByIdAndUpdate(
            user._id,
            {
                $set: {
                    'subscription.status': plan,
                    'subscription.stripeCustomerId': customer?.id || subscription.customer,
                    'subscription.stripeSubscriptionId': subscription.id,
                    'subscription.stripePriceId': priceId,
                    'subscription.currentPeriodStart': new Date(subscription.current_period_start * 1000),
                    'subscription.currentPeriodEnd': new Date(subscription.current_period_end * 1000),
                    'subscription.cancelAtPeriodEnd': subscription.cancel_at_period_end
                }
            },
            { new: true }
        ).select('email username subscription').lean();

        printJson('Target Mongo User Updated', {
            before,
            after: updatedUser
        });
    }

    const sinceTimestamp = Math.floor(new Date(`${target.since}T00:00:00-04:00`).getTime() / 1000);
    const recentSubscriptions = await stripe.subscriptions.list({
        created: { gte: sinceTimestamp },
        status: 'all',
        limit: 100,
        expand: ['data.customer']
    });

    const recentRows = [];
    for (const sub of recentSubscriptions.data) {
        const summary = summarizeSubscription(sub);
        const subCustomer = sub.customer;
        const users = await findMongoUsers({
            customerId: subCustomer?.id || sub.customer,
            subscriptionId: sub.id,
            email: subCustomer?.email,
            metadataUserId: subCustomer?.metadata?.userId || sub.metadata?.userId
        });

        recentRows.push({
            ...summary,
            customerEmail: subCustomer?.email,
            customerName: subCustomer?.name,
            customerMetadata: subCustomer?.metadata,
            mongoMatches: users.map((user) => ({
                id: user._id,
                email: user.email,
                username: user.username,
                plan: user.subscription?.status,
                stripeCustomerId: user.subscription?.stripeCustomerId,
                stripeSubscriptionId: user.subscription?.stripeSubscriptionId,
                currentPeriodEnd: user.subscription?.currentPeriodEnd
            }))
        });
    }

    printJson(`Stripe Subscriptions Since ${target.since}`, recentRows);

    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error('\nLookup failed:', error.message);
    if (error?.raw?.message) console.error('Stripe details:', error.raw.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});

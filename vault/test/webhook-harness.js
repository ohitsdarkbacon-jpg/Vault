// Thin re-export so the test drives the SAME payout-IPN code the webhook uses.
module.exports = { handlePayoutIpn: require('../src/lib/payouts').handlePayoutIpn };

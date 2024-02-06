const asyncAuto = require('async/auto');
const {returnResult} = require('asyncjs-util');

const {sendMessageToPeer, parsePaymentRequest, payViaPaymentRequest, sendToChainAddress} = require('ln-service');
const {requests}  = require('./requests.json');
const encodeMessage = n => Buffer.from(JSON.stringify(n)).toString('hex');
const {constants} = require('./constants.json');
const lightningPaymentType = 'lightning';
const onchainPaymentType = 'onchain';

module.exports = (args, cbk) => {
  return new Promise((resolve, reject) => {
    return asyncAuto({
      // Check arguements
      validate: cbk => {
        if (args.announce_channel === undefined) {
          return cbk([400, 'ExpectedAnnounceChannelToBuyChannel']);
        }

        if (!args.ask) {
          return cbk([400, 'ExpectedAskFunctionToBuyChannel']);
        }

        if (!args.lnd) {
          return cbk([400, 'ExpectedAuthenticatedLndBuyChannel']);
        }

        if (!args.logger) {
          return cbk([400, 'ExpectedLoggerToBuyChannel']);
        }

        if (!args.message) {
          return cbk([400, 'ExpectedMessageToBuyChannel']);
        }

        if (!args.priority) {
          return cbk([400, 'ExpectedPriorityToBuyChannel']);
        }

        if (!args.pubkey) {
          return cbk([400, 'ExpectedPubkeyToBuyChannel']);
        }

        if (!args.tokens) {
          return cbk([400, 'ExpectedTokensToBuyChannel']);
        }

        if (!args.type) {
          return cbk([400, 'ExpectedTypeToBuyChannel']);
        }

        return cbk();
      },

      // Request info
      validateMessage: ['validate', ({}, cbk) => {
        const {message} = args;

        if (!message.order_id) {
          return cbk([400, 'ExpectedOrderIdToBuyChannel']);
        }

        if (Number(message.lsp_balance_sat) !== args.tokens) {
          return cbk([400, 'ExpectedTokensToMatchLspBalance']);
        }

        if (message.client_balance_sat !== '' && message.client_balance_sat !== '0') {
          return cbk([400, 'ExpectedZeroClientBalanceToBuyChannel']);
        }

        if (message.confirms_within_blocks !== args.priority) {
          return cbk([400, 'ExpectedPriorityToMatchConfirmsWithinBlocks']);
        }

        if (message.channel_expiry_blocks !== constants.channelExpiryBlocks) {
          return cbk([400, 'ExpectedMatchingChannelExpiryBlocksToBuyChannel']);
        }

        if (message.announce_channel !== args.announce_channel) {
          return cbk([400, 'ExpectedMatchingAnnounceChannelToBuyChannel']);
        }

        if (message.order_state !== constants.orderStates.created) {
          return cbk([400, 'ExpectedOrderStateToBeCreatedToBuyChannel']);
        }

        if (!message.payment) {
          return cbk([400, 'ExpectedPaymentDetailsToBuyChannel']);
        }

        const {payment} = message;

        // Fee total and order total sats should match because we don't support push amounts
        if (payment.fee_total_sat !== payment.order_total_sat) {
          return cbk([400, 'ExpectedMatchingFeeAndOrderTotalSatToBuyChannel']);
        }

        if (payment.state !== constants.paymentStates.expectPayment) {
          return cbk([400, 'ExpectedExpectPaymentStateToBuyChannel']);
        }

        if (!payment.fee_total_sat) {
          return cbk([400, 'ExpectedFeeTotalSatToBuyChannel']);
        }

        if (!payment.order_total_sat) {
          return cbk([400, 'ExpectedOrderTotalSatToBuyChannel']);
        }

        try {
          const res = parsePaymentRequest({request: payment.lightning_invoice});

          if (res.tokens !== Number(payment.order_total_sat)) {
            return cbk([400, 'ExpectedMatchingTokensInPaymentRequest']);
          }
        } catch (err) {
          return cbk([400, 'ExpectedValidPaymentRequestToBuyChannel', {err}]);
        }

        return cbk();
      }],

      // Ask to buy the channel
      ask: ['validateMessage', ({}, cbk) => {
        args.logger.info({
          order_id: args.message.order_id,
          channel_size: args.message.lsp_balance_sat,
          confirms_within_blocks: args.message.confirms_within_blocks,
          expiry_blocks: args.message.channel_expiry_blocks,
          is_private: !args.announce_channel,
          fees: args.message.payment.order_total_sat,
        });

        return args.ask({
          default: true,
          message: 'Do you want to buy the channel?',
          name: 'confirm',
          type: 'confirm',
        },
        ({confirm}) => {
          if (!confirm) {
            return cbk([400, 'BuyCancelled']);
          }

          return cbk(null, confirm);
        });
      }],

      // Ask for onchain or offchain payment
      askPaymentType: ['ask', ({}, cbk) => {
        // Exit early if onchain payment is not supported
        const {payment} = args.message;

        if (!payment.onchain_address || payment.onchain_address === '') {
          return cbk(null, {type: 'lightning'});
        }

        return args.ask({
          message: 'Do you want to pay with onchain or lightning funds?',
          name: 'payment_type',
          type: 'list',
          choices: [lightningPaymentType, onchainPaymentType],
        },
        ({payment_type}) => cbk(null, {type: payment_type}));
      }],

      // Pay lightning invoice
      payLightning: ['askPaymentType', ({askPaymentType}, cbk) => {
        if (askPaymentType.type !== lightningPaymentType) {
          return cbk();
        }

        const {payment} = args.message;

        return payViaPaymentRequest({
          lnd: args.lnd,
          request: payment.lightning_invoice,
        },
        cbk)
      }],

      // Send onchain payment
      payOnchain: ['askPaymentType', ({askPaymentType}, cbk) => {
        if (askPaymentType.type !== onchainPaymentType) {
          return cbk();
        }

        const {payment} = args.message;

        return sendToChainAddress({
          address: payment.onchain_address,
          lnd: args.lnd,
          target_confirmations: constants.targetConfsForOnchainPayment,
          tokens: Number(payment.order_total_sat)
        }, 
        cbk)
      }],

      // Payment sent
      paymentSent: ['payLightning', 'payOnchain', ({}, cbk) => {
        args.logger.info({payment_sent: true});

        return cbk();
      }],
    },
    returnResult({reject, resolve}, cbk));
  });
}
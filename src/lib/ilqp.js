'use strict'

const IlpPacket = require('ilp-packet')
const Packet = require('../utils/packet')
const debug = require('debug')('ilp:ilqp')
const moment = require('moment')
const BigNumber = require('bignumber.js')
const { safeConnect, startsWith, xor, omitUndefined } =
  require('../utils')
const compat = require('ilp-compat-plugin')

const DEFAULT_MESSAGE_TIMEOUT = 5000
const DEFAULT_EXPIRY_DURATION = 10

function _serializeQuoteRequest (requestParams) {
  if (requestParams.sourceAmount) {
    return IlpPacket.serializeIlqpBySourceRequest(requestParams)
  }
  if (requestParams.destinationAmount) {
    return IlpPacket.serializeIlqpByDestinationRequest(requestParams)
  }
  return IlpPacket.serializeIlqpLiquidityRequest(requestParams)
}

/**
  * @param {Object} params
  * @param {Object} params.plugin The LedgerPlugin used to send quote request
  * @param {Object} params.quoteQuery ILQP request packet parameters
  * @param {Integer} [params.timeout] Milliseconds
  * @returns {Object} Ilqp{Liquidity,BySourceAmount,ByDestinationAmount}Response or IlpError
  */
function quoteByConnector ({
  plugin,
  quoteQuery,
  timeout
}) {
  plugin = compat(plugin)
  const requestPacket = _serializeQuoteRequest(quoteQuery)
  const requestType = requestPacket[0]

  debug('remote quote', 'query=' + JSON.stringify(quoteQuery))
  return plugin.sendRequest({
    ilp: requestPacket.toString('base64'),
    timeout: timeout || DEFAULT_MESSAGE_TIMEOUT
  }).then((response) => {
    if (!response.ilp) throw new Error('Quote response has no packet')
    const responsePacket = Buffer.from(response.ilp, 'base64')
    const responseType = responsePacket[0]
    const packetData = IlpPacket.deserializeIlpPacket(responsePacket).data
    const isErrorPacket = responseType === IlpPacket.Type.TYPE_ILP_ERROR
    if (isErrorPacket) {
      debug('remote quote error', 'ilpError=' + JSON.stringify(packetData))
    }
    if (isErrorPacket || responseType === requestType + 1) {
      return Object.assign({responseType}, packetData)
    }
    throw new Error('Quote response packet has incorrect type')
  })
}

function _getCheaperQuote (quote1, quote2) {
  if (quote1.sourceAmount) {
    const source1 = new BigNumber(quote1.sourceAmount)
    if (source1.lessThan(quote2.sourceAmount)) return quote1
  } else {
    const dest1 = new BigNumber(quote1.destinationAmount)
    if (dest1.greaterThan(quote2.destinationAmount)) return quote1
  }
  return quote2
}

/**
  * @module ILQP
  */

/**
  * @param {Object} plugin The LedgerPlugin used to send quote request
  * @param {Object} query
  * @param {String} query.sourceAddress Sender's address
  * @param {String} query.destinationAddress Recipient's address
  * @param {String} [query.sourceAmount] Either the sourceAmount or destinationAmount must be specified. This value is a string representation of an integer, expressed in the lowest indivisible unit supported by the ledger.
  * @param {String} [query.destinationAmount] Either the sourceAmount or destinationAmount must be specified. This value is a string representation of an integer, expressed in the lowest indivisible unit supported by the ledger.
  * @param {String|Number} [query.destinationExpiryDuration] Number of seconds between when the destination transfer is proposed and when it expires.
  * @returns {Promise<Quote>}
  */
async function quote (plugin, {
  sourceAddress,
  destinationAddress,
  sourceAmount,
  destinationAmount,
  destinationExpiryDuration,
  timeout
}) {
  plugin = compat(plugin)

  if (!xor(sourceAmount, destinationAmount)) {
    throw new Error('should provide source or destination amount but not both' +
      ' ' + JSON.stringify({ sourceAmount, destinationAmount }))
  }

  await safeConnect(plugin, timeout)
  const prefix = plugin.getInfo().prefix
  const amount = sourceAmount || destinationAmount
  const destinationHoldDuration = +(destinationExpiryDuration || DEFAULT_EXPIRY_DURATION)

  if (startsWith(prefix, destinationAddress)) {
    debug('returning a local transfer to', destinationAddress, 'for', amount)
    return omitUndefined({
      // send directly to the destination
      connectorAccount: destinationAddress,
      sourceAmount: amount,
      destinationAmount: amount,
      sourceExpiryDuration: destinationHoldDuration.toString()
    })
  }

  const quoteQuery = omitUndefined({
    destinationAccount: destinationAddress,
    destinationHoldDuration: destinationHoldDuration * 1000,
    sourceAmount,
    destinationAmount
  })

  debug('quoting', amount,
    (sourceAmount ? '(source amount)' : '(destination amount)'),
    'to', destinationAddress)

  // handle connector responses will return all successful quotes, or
  // throw all errors if there were none.
  const quote = await quoteByConnector({ plugin, quoteQuery, timeout })

  if (!quote) {
    throw new Error('got empty quote response: ' + quote)
  } else if (quote.responseType === IlpPacket.Type.TYPE_ILP_ERROR) {
    throw new Error('remote quote error: ' + quote.name)
  }

  const sourceHoldDuration = quote.sourceHoldDuration / 1000
  debug('got quote:', JSON.stringify(quote))

  return omitUndefined({
    sourceAmount: sourceAmount || quote.sourceAmount,
    destinationAmount: destinationAmount || quote.destinationAmount,
    sourceExpiryDuration: sourceHoldDuration.toString(),
    // current time plus sourceExpiryDuration, for convenience
    expiresAt: moment()
      .add(sourceHoldDuration, 'seconds')
      .toISOString()
  })
}

async function quoteByPacket (plugin, packet, params) {
  const { account, amount } = Packet.parse(packet)
  return quote(plugin, Object.assign({
    destinationAmount: amount,
    destinationAddress: account
  }, params))
}

module.exports = {
  _getCheaperQuote,
  quoteByConnector,
  quote,
  quoteByPacket
}

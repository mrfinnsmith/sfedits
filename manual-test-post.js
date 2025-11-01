#!/usr/bin/env node

const { getConfig, getStatus, sendStatus } = require('../page-watch')

const fakeEdit = {
    wikipedia: 'English Wikipedia',
    page: 'San Francisco Board of Supervisors',
    user: 'TestUser',
    url: 'https://en.wikipedia.org/w/index.php?title=San_Francisco_Board_of_Supervisors&diff=1291466791&oldid=1285793500'
}

const config = getConfig('./config.json')
const account = config.accounts[0]

// Check if this page is in the watchlist
if (account.watchlist &&
    account.watchlist[fakeEdit.wikipedia] &&
    account.watchlist[fakeEdit.wikipedia][fakeEdit.page]) {

    const status = getStatus(fakeEdit, fakeEdit.user, account.template)
    sendStatus(account, status, fakeEdit)
}
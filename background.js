/*
 * RELAXATION: assume every url is unique in a window, 
 * and each tab permutation in a window is unique in a session
 *
 * TODO:
 * Able to toggle syncing with browser action
 * Able to have session management
 * Able to manage sessions
 * Able to exclude tabs from syncing
 * Able to manage windows/tabs in sessions
 */

var options = {
      servers: [
        'http://localhost:5000',
      ],
      getPrev: true,
      dryRun: true,
      autoSync: true,
      sync: true,
      refresh: 3000,
    },
    global = {
      lastPendingTask: 'none',
      logs: [],
      revision: null,
      prevWindows: [],
      currentServer: options.servers[0],
    }

function pickAServer() {
  var x = Math.floor(Math.random() * global.servers.length-1)
  return global.servers[x]
}

function pull(revision) {
  return $.get(global.currentServer, {revision: revision}, null, 'json')
    .fail(function (xhr, st) {
      console.log('fail', xhr.statusText)
      if (st == 'timeout') {
        global.currentServer = pickAServer()
        return pull()
      }
    })
}

function push() {
  var self = this,
      data = arguments

  return $.post(global.currentServer, {command: 'push', data: data})
    .fail(function (xhr, st) {
      console.log('fail', xhr.statusText)
      if (st == 'timeout') {
        global.currentServer = pickAServer()
        return push.apply(self, arguments) // Infinite retry
      }
    }).done(function (data) {
      // Clear logs
      console.log('pushed all local changes to server', global.logs)
      global.logs = []
      // Update revision
      getLatestRemoteState().then(function (state) {
        console.log('update revision to', state.revision)
        global.revision = state.revision
      })
    })
}

function reverseLogs(logs) {
  return logs.slice().reverse().map(function (log) {
    switch (log.action) {
    case 'created':
      return {
        action: 'removed',
        type: log.type,
        info: log.info
      }
      break
    case 'updated':
      var revLog = $.extend({}, log),
          tempUrl = revLog.info.url
      revLog.info.url = revLog.info.prevUrl
      revLog.info.prevUrl = tempUrl
      return revLog
      break
    case 'moved':
      var revLog = $.extend({}, log),
          tempIndex = revLog.info.index

      // Change urls to after it has been moved
      var url = revLog.info.urls[revLog.info.fromIndex]
      revLog.info.urls.splice(revLog.info.index, 1, url)
      revLog.info.urls.splice(revLog.info.fromIndex, 1)

      // Reverse indexes
      revLog.info.index = revLog.info.fromIndex
      revLog.info.fromIndex = tempUrl
      return revLog
      break
    case 'removed':
      return {
        action: 'created',
        type: log.type,
        info: {
          index: log.info.index,
          url: log.info.url,
          urls: log.info.urls.slice().filter(function (url, ind) { return ind == log.info.index })
        }
      }
      break
    }
  })
}

function getLatestRemoteState() {
  console.log('getLatestRemoteState')
  return pull().then(function (states) {
    return states[0]
  })
}

// Reset state to revision
function resetTo(revision) {
  var revLogs = reverseLogs(global.logs)
  return apply(revLogs)
}

// Apply whatever in logs to current state
function applyLogs() {
  return apply([{logs: global.logs}]) // apply should gather a list of conflicts to be resolved by the user
}

function rebase() {
  global.lastPendingTask = 'rebase'
  return resetTo(global.revision)
    .then(fastForward)
    .then(applyAll) // conflicts should be resolved automatically (let user decide later)
    .then(pushAll)
    .then(function () {
      global.lastPendingTask = 'none'
    })
}

function apply(states) {
  var headAction = Q(true)
  // Apply to client
  states.forEach(function (state) {
    state.logs.forEach(function (log) {
      switch (log.action) {
      case 'created':
        if (log.type == 'tab') {
          headAction.then(function () {
            var defer = Q.defer()
            getWindows().then(function (windows) {
              windows.forEach(function (w) {
                // log.info.urls: list of urls of the window before the tab was added
                if (log.info.urls == w.tabs.map(function (t) { return t.url })) {
                  log.info.windowId = w.id
                  if (options.dryRun) {
                    console.log('tab create', log.info)
                  } else {
                    chrome.tabs.create(log.info, defer.resolve)
                  }
                }
              })
            })
            return defer.promise
          })
        } else {
          headAction.then(function () {
            var defer = Q.defer()
            if (options.dryRun) {
              console.log('window create', log.info)
            } else {
              chrome.windows.create(log.info, defer.resolve)
            }
            return defer.promise
          })
        }
        break
      case 'moved':
        if (log.type == 'tab') {
          headAction.then(function () {
            var defer = Q.defer()
            getWindows().then(function (windows) {
              windows.forEach(function (w) {
                // log.info.urls: list of urls of the window before the tab was changed
                if (log.info.urls == w.tabs.map(function (t) { return t.url })) {
                  var tab = w.tabs[log.info.fromIndex]
                  if (options.dryRun) {
                    console.log('tab move', tab.id, log.info)
                  } else {
                    chrome.tabs.move(tab.id, log.info, defer.resolve)
                  }
                }
              })
            })
            return defer.promise
          })
        }
        break
      case 'updated':
        if (log.type == 'tab') {
          headAction.then(function () {
            var defer = Q.defer()
            getWindows().then(function (windows) {
              windows.forEach(function (w) {
                // log.info.urls: list of urls of the window before the tab was changed
                if (log.info.urls == w.tabs.map(function (t) { return t.url })) {
                  var tab = w.tabs[log.info.index]
                  if (options.dryRun) {
                    console.log('tab update', tab.id, log.info)
                  } else {
                    chrome.tabs.update(tab.id, log.info, defer.resolve)
                  }
                }
              })
            })
            return defer.promise
          })
        }
        break
      case 'removed':
        if (log.type == 'tab') {
          headAction.then(function () {
            var defer = Q.defer()
            getWindows().then(function (windows) {
              windows.forEach(function (w) {
                // log.info.urls: list of urls of the window before the tab was changed
                if (log.info.urls == w.tabs.map(function (t) { return t.url })) {
                  var tab = w.tabs[log.info.index]
                  if (options.dryRun) {
                    console.log('tab remove', tab.id)
                  } else {
                    chrome.tabs.remove(tab.id, defer.resolve)
                  }
                }
              })
            })
            return defer.promise
          })
        } else {
          headAction.then(function () {
            var defer = Q.defer()
            getWindows().then(function (windows) {
              windows.forEach(function (w) {
                // log.info.urls: list of urls of the window before the tab was changed
                if (log.info.urls == w.tabs.map(function (t) { return t.url })) {
                  if (options.dryRun) {
                    console.log('window remove', w.id)
                  } else {
                    chrome.windows.remove(w.id, defer.resolve)
                  }
                }
              })
            })
            return defer.promise
          })
        }
        break
      }
    })
  })
  return headAction
}

function pushAll() {
  console.log('pushAll')
  return getWindows().then(function (windows) {
    return push({logs: global.logs, snapshot: windows})
  })
}

function fastForward() {
  return pull(global.revision+1).then(function (states) {
    apply(states).then(function () {
      global.revision = states.slice(-1)[0].revision
      console.log('fast forwarded to', global.revision)
    })
  })
}

function getWindow(windowId) {
  var defer = Q.defer()
  chrome.windows.get(windowId, {populate: true}, defer.resolve)
  return defer.promise
}

// Only normal windows
function getWindows() {
  function filter(windows) {
    return windows.filter(function (win) {
      return win.type == 'normal' && !win.incognito
    })
  }

  var defer = Q.defer()
  chrome.windows.getAll({populate: true}, function (windows) {
    defer.resolve(filter(windows))
  })
  return defer.promise
}

function getPrevWindow(windowId, cb) {
  getPrevWindows(function (windows) {
    windows.forEach(function (w) {
      if (w.id == windowId) {
        cb(w)
      }
    })
  })
}

function getPrevWindows(callback) {
  options.getPrev = false
  callback(global.prevWindows)
  options.getPrev = true
}

function toUrls(tabs) {
  return tabs.map(function (t) { return t.url })
}


// Callbacks
function windowsOnRemoved(windowId) {
  console.log('windows.onRemoved', windowId)
  getPrevWindow(windowId, function (w) {
    global.logs.push({
      action: 'removed',
      type: 'window',
      info: {
        urls: w.tabs.map(function (tab) { return tab.url })
      }
    })
  })
}

function windowsOnCreated(w) {
  console.log('windows.onCreated', w)
  global.logs.push({
    action: 'created',
    type: 'window',
    info: {
      incognito: w.incognito,
      type: w.type
    }
  })
}

function onCreated(tab) {
  console.log('tabs.onCreated', tab, tab.id)
  getPrevWindow(tab.windowId, function (w) {
    // For new window, urls should be an empty list
    global.logs.push({
      action: 'created',
      type: 'tab',
      info: {
        index: tab.index,
        url: tab.url,
        urls: toUrls(w.tabs)
      }
    })
  })
}

function onAttached(tabId, attachInfo) {
  console.log('tabs.onAttached', tabId, attachInfo)
  chrome.tab.get(tabId, function (tab) {
    onCreated(tab)
  })
}

function onUpdated(tabId, changeInfo, tab) {
  console.log('tabs.onUpdated', tabId, changeInfo, tab)
  // Loading is called first
  if (changeInfo.status == 'loading') {
    getPrevWindow(tab.windowId, function (w) {
      // onUpdated will be called multiple times
      // Make sure the url is different
      if (w.tabs[tab.index].url != tab.url) {
        global.logs.push({
          action: 'updated',
          type: 'tab',
          info: {
            index: tab.index,
            url: changeInfo.url,
            urls: toUrls(w.tabs),
            prevUrl: w.tabs[tab.index].url
          }
        })
      }
    })
  }
}

function onMoved(tabId, moveInfo) {
  console.log('tabs.onMoved', tabId, moveInfo)
  getPrevWindow(moveInfo.windowId, function (w) {
    global.logs.push({
      action: 'moved',
      type: 'tab',
      info: {
        index: moveInfo.toIndex,
        fromIndex: moveInfo.fromIndex,
        urls: toUrls(w.tabs)
      }
    })
  })
}

function onRemoved(tabId, removeInfo) {
  console.log('tabs.onRemoved', tabId, removeInfo)
  getPrevWindow(removeInfo.windowId, function (w) {
    // removeInfo.isWindowClosing is not reliable
    w.tabs.forEach(function (tab) {
      if (tab.id == tabId) {
        global.logs.push({
          action: 'removed',
          type: 'tab',
          info: {
            index: tab.index,
            urls: toUrls(w.tabs),
            url: tab.url, // For reverse
          }
        })
      }
    })
  })
}

function onDetached(tabId, detachInfo) {
  console.log('tabs.onDetached', tabId, detachInfo)
  onRemoved(tabId, detachInfo)
}

chrome.windows.onCreated.addListener(windowsOnCreated)

chrome.windows.onRemoved.addListener(windowsOnRemoved)

chrome.tabs.onCreated.addListener(onCreated)

chrome.tabs.onAttached.addListener(onAttached)

chrome.tabs.onUpdated.addListener(onUpdated)

chrome.tabs.onMoved.addListener(onMoved)

chrome.tabs.onRemoved.addListener(onRemoved)

chrome.tabs.onDetached.addListener(onDetached)

chrome.browserAction.onClicked.addListener(function (tab) {
  if (options.sync) {
    chrome.browserAction.disable()
    options.sync != options.sync
  } else {
    chrome.browserAction.enable()
    options.sync != options.sync
  }
})

// For getting the previous state before the callback called
setInterval(function () {
  if (options.getPrev) {
    getWindows().then(function (windows) {
      global.prevWindows = windows
    })
  }
}, 300)

setInterval(function () {
  console.log('tick')
  // Only new windows/tabs are auto in sync,
  // old windows/tabs need users explicitly enable to sync (using page action)
  if (options.autoSync && options.sync) {
    getLatestRemoteState().then(function (state) {
      if (state && state.revision > global.revision) {
        if (global.logs.length == 0) {
          return fastForward()
        } else {
          return rebase()
        }
      } else {
        // push all local changes as a snapshot to state machine
        if (global.revision === null || (global.revision % 1 === 0 && global.logs.length > 0)) {
          return pushAll() 
        }
      }
    })
  }
}, options.refresh)

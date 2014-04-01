/*
 * TODO:
 * Able to toggle syncing with browser action
 * Able to have session management
 * Able to manage sessions
 * Able to exclude tabs from syncing
 * Able to manage windows/tabs in sessions
 */

var servers = [
      'http://localhost:5000',
    ],
    options = {
      platform: 'chrome',
      threshold: 0.9,
      autoSync: true,
      sync: true,
      dryRun: true,
      interval: 3000
    },
    deletedTabs = {},
    tabLastChange = {},
    dirty = false,
    currentServer = servers[0]

function LCS(sequenceL, sequenceR) {
  var memoization = {}

  memoization[',,'] = []
  sequenceL.forEach(function (x, i) {
    memoization[i.toString() + ','] = []
  })

  sequenceR.forEach(function (y, j) {
    memoization[',' + j.toString()] = []
  })

  var LCSBase = function (l, r) {
    var index = (l.length == 0 ? ',' : (l.length-1).toString()) + (r.length == 0 ? ',' : (r.length-1).toString())
    if (memoization[index]) {
      return memoization[index]
    }

    if (l[l.length-1] != r[r.length-1]) {
      var one = LCSBase(l.slice(0, l.length-1), r)
          two = LCSBase(l, r.slice(0, r.length-1))

      if (one.length > two.length)
        memoization[index] = one
      else
        memoization[index] = two

      return memoization[index]
    } else {
      var result = LCSBase(l.slice(0, l.length-1), r.slice(0, r.length-1))
      memoization[index] = result.concat(l[l.length-1])
      return memoization[index]
    }
  }

  return LCSBase(sequenceL, sequenceR)
}


function pickAServer() {
  var x = Math.floor(Math.random() * servers.length-1)
  return servers[x]
}

function pull() {
  return $.get(currentServer)
    .fail(function (xhr, st) {
      console.log('fail', xhr.statusText)
      if (st == 'timeout') {
        currentServer = pickAServer()
        return pull()
      }
    })
}

function push(current, name) {
  var self = this,
      data = arguments

  return $.post(currentServer, {command: 'push', data: data})
    .fail(function (xhr, st) {
      console.log('fail', xhr.statusText)
      if (st == 'timeout') {
        currentServer = pickAServer()
        return push.apply(self, arguments) // Infinite retry
      }
    })
}

function similarity(winL, winR) {
  var denominator = Math.max(winL.tabs.length, winR.tabs.length)
  var numerator = LCS(winL.tabs.map(function (tab) {
    return tab.url
  }), winR.tabs.map(function (tab) {
    return tab.url
  })).length

  return numerator / denominator
}

function mapping(local, remote) {
  var localToRemote = {}

  // Three kinds of changes: add, remove, change
  local.forEach(function (windowL, indexL) {
    remote.forEach(function (windowR, indexR) {
      if (similarity(windowL, windowR) >= options.threshold)
        localToRemote[indexL] = indexR
    })
  })

  return localToRemote
}

function merge(fromState, toState, isToStateFresh) {
  var mergedState = []

  var fromStateTotoState = mapping(fromState, toState)

  if (Object.keys(fromStateTotoState).length < fromState.length) {
    fromState.forEach(function (win, index) {
      if (Object.keys(fromStateTotoState).indexOf(index) < 0) {
        mergedState.push(win)
      }
    })
  }

  if (_.values(fromStateTotoState).length < toState.length) {
    toState.forEach(function (win, index) {
      if (_.values(fromStateTotoState).indexOf(index) < 0) {
        mergedState.push(win)
      }
    })
  }

  Object.keys(fromStateTotoState).forEach(function (index) {
    var state = fromState[index]
    // FIXME: Ask user or by default just merge everything with duplicates
    // Need different merge strategy

    // This takse the newest tabs for tabs that both present and changed
    for (var i = 0; i < state.tabs.length; i++) {
      var tab = state.tabs[i],
          neighbors = [state.tabs[i-1], state.tabs[i+1]]

      for (var j = 0; j < toState[index].tabs.length; j++) {
        var jab = toState[index].tabs[j],
            jeighbors = [toState[index].tabs[j-1], toState[index].tabs[j+1]]

        if (neighbors == jeighbors && tab.lastChanged.getTime() < jab.lastChanged.getTime()) {
          state.tabs[i] = jab
        }
      }
    }

    // Add tabs that are not in current window session
    for (var i = 0; i < toState[index].tabs.length; i++) {
      var tab = toState[index].tabs[i],
          neighbors = [toState[index].tabs[i-1], toState[index].tabs[i+1]]

      var has = false
      for (var j = 0; j < state.tabs.length; j++) {
        var jab = state.tabs[j],
            jeighbors = [state.tabs[j-1], state.tabs[j+1]]

        if (neighbors == jeighbors && tab.url == jab.url) {
          has = true
        }
      }

      // Not a tab deleted locally
      if (!has && !deletedTabs[tab.id]) {
        if (i < state.tabs.length) {
          state.tabs.splice(i, 1, tab)
        } else {
          state.tabs.push(tab)
        }
      }
    }

    // TODO: handle conflict, remote change a tab, but local delete that tab, vice versa

    mergedState.push(state)
  })

  return mergedState
}

function diff(fromState, toState) {
  var changes = []

  var fromStateTotoState = mapping(fromState, toState)
  if (Object.keys(fromStateTotoState).length < fromState.length) {
    // Close windows
    fromState.forEach(function (win, index) {
      if (Object.keys(fromStateTotoState).indexOf(index) < 0) {
        changes.push({
          action: 'remove',
          type: 'window',
          windowId: win[options.platform].windowId
        })
      }
    })
  }

  if (_.values(fromStateTotoState).length < toState.length) {
    // New windows
    toState.forEach(function (win, index) {
      if (_.values(fromStateTotoState).indexOf(index) < 0) {
        changes.push({
          action: 'create',
          type: 'window',
          info: {
            tabs: win.tabs.map(function (tab) {
              return tab.url
            })
          }
        })
      }
    })
  }
  
  for (var fromStateIndex in fromStateTotoState) {
    if (fromStateTotoState.hasOwnProperty(fromStateIndex)) {
      var fromStateTabs = fromState[fromStateIndex].tabs,
          toStateTabs = toState[fromStateTotoState[fromStateIndex]].tabs,
          commonTabUrls = LCS(fromStateTabs.map(function (tab) {
            return tab.url
          }), toStateTabs.map(function (tab) {
            return tab.url
          }))

      var indexC = 0,
          indexS = 0,
          indexD = 0

      while (indexC < commonTabUrls.length) {
        var commonTabUrl = commonTabUrls[indexC],
            fromStateTab = fromStateTabs[indexS]
        if (commonTabUrl == fromStateTab.url) {
          indexC += 1
          indexS += 1
        } else if (commonTabUrl != fromStateTab.url) {
          indexC += 1
          changes.push({
            action: 'remove',
            type: 'tab',
            tabId: fromStateTab[options.platform].tabId
          })
        }
      }

      indexC = 0
      while (indexC < commonTabUrls.length) {
        var commonTabUrl = commonTabUrls[indexC],
            toStateTab = toStateTabs[indexD]
        if (commonTabUrl == toStateTab.url) {
          indexC += 1
          indexD += 1
        } else if (commonTabUrl != toStateTab.url) {
          indexC += 1
          changes.push({
            action: 'create',
            type: 'tab',
            info: {
              url: toStateTab,
              windowId: fromStateIndex,
              index: indexC
            }
          })
        }
      }
    }
  }

  return changes
}

function apply(changes) {
  if (!options.dryRun) {
    // Apply to client
    changes.forEach(function (change) {
      switch (change.action) {
      case 'create':
        if (change.type == 'tab') {
          chrome.tabs.create(change.info)
        } else {
          chrome.windows.create(change.info)
        }
        break
      case 'update':
        if (change.type == 'tab') {
          chrome.tabs.update(change.tabId, change.info)
        } else {
          chrome.windows.update(change.windowId, change.info)
        }
        break
      case 'remove':
        if (change.type == 'tab') {
          chrome.tabs.remove(change.tabId)
        } else {
          chrome.windows.remove(change.windowId)
        }
        break
      }
    })
  } else {
    console.log('apply changes')
    console.log(changes)
  }
}

// Format windows returned to valid format accepted by SM
function format(windows) {
  return windows.filter(function (win) {
    return win.type == 'normal'
  }).map(function (win, ind) {
    var tabs = win.tabs.map(function (tab) {
      return {
        chrome: {
          tabId: tab.id
        },
        lastChanged: tabLastChange[tab.id],
        url: tab.url
      }
    })
    return {
      chrome: {
        windowId: win.id
      },
      tabs: tabs
    }
  })
}

if (options.autoSync) {
  var pushIntervalId = setInterval(function () {
    if (options.sync) {
      chrome.windows.getAll({populate: true}, function (windows) {
        if (dirty) {
          console.log('push')
          push(format(windows), null).then(function () {
            dirty = false
          })
        }
      })
    }
  }, options.interval)

  var pullIntervalId = setInterval(function () {
    if (options.sync) {
      pull().done(function (state) {
        chrome.windows.getAll({populate: true}, function (windows) {
          var changes = diff(format(windows), state.snapshot || [])
          if (changes.length > 0) {
            dirty = true
            apply(diff(format(windows), merge(format(windows), state.snapshot || [])))
          }
        })
      })
    }
  }, options.interval)
}


chrome.windows.onCreated.addListener(function (window) {
  // Track changes locally to localStorage that persist through browser restarts
  // then apply them once user turn sync back on
  console.log('windows.onCreated', window)
  if (window.type == 'normal' && !window.incognito) {
  }
})

chrome.windows.onRemoved.addListener(function (windowId) {
  console.log('windows.onRemoved', windowId)
})

chrome.tabs.onCreated.addListener(function (tab) {
  console.log('tabs.onCreated', tab, tab.id)
  delete deletedTabs[tab.id]
})

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  console.log('tabs.onUpdated', tabId, changeInfo, tab)
  if (changeInfo.status == 'loading') {
    tabLastChange[tabId] = new Date()
  }
})

chrome.tabs.onMoved.addListener(function (tabId, moveInfo) {
  console.log('tabs.onMoved', tabId, moveInfo)
  tabLastChange[tabId] = new Date()
})

chrome.tabs.onDetached.addListener(function (tabId, detachInfo) {
  console.log('tabs.onDetached', tabId, detachInfo)
  tabLastChange[tabId] = new Date()
  deletedTabs[tabId] = new Date()
})

chrome.tabs.onAttached.addListener(function (tabId, attachInfo) {
  console.log('tabs.onAttached', tabId, attachInfo)
  tabLastChange[tabId] = new Date()
  delete deletedTabs[tabId]
})

chrome.tabs.onRemoved.addListener(function (tabId, removeInfo) {
  console.log('tabs.onRemoved', tabId, removeInfo)
  tabLastChange[tabId] = new Date()
  deletedTabs[tabId] = new Date()
  if (removeInfo.isWindowClosing) {
  }
})

chrome.browserAction.onClicked.addListener(function (tab) {
  if (options.sync) {
    chrome.browserAction.disable()
    options.sync != options.sync
  } else {
    chrome.browserAction.enable()
    options.sync != options.sync
  }
})

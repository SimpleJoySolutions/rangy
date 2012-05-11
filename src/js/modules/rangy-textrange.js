/**
 * Text range module for Rangy.
 * A generic framework for creating text mutation commands for Ranges and Selections
 *
 * Part of Rangy, a cross-browser JavaScript range and selection library
 * http://code.google.com/p/rangy/
 *
 * Depends on Rangy core.
 *
 * Copyright %%build:year%%, Tim Down
 * Licensed under the MIT license.
 * Version: %%build:version%%
 * Build date: %%build:date%%
 */
/**
 * Scope
 *
 * - Add ability to move range boundaries by character or word offsets
 * - Ignore text nodes inside <script> or <style> elements
 * - Do not ignore text nodes that are outside normal document flow
 * - Add a find method to search for text (optionally case sensitive, default insensitive) within the range
 * - Add ability to add custom word boundary finder (regex?)
 * - Add method to range to return a boundary as a text offset within a node
 * - Add method to selection to get the selection as text offsets within an optional node (body otherwise)
 * - Add method to selection to set the selection as text offsets within an optional node (body otherwise) and direction
 * - Add method to selection to return visible text
 * - Add window.find() equivalent
 * - Add innerText equivalent
 *
 * References
 *
 * https://www.w3.org/Bugs/Public/show_bug.cgi?id=13145
 * http://aryeh.name/spec/innertext/innertext.html
 * http://dvcs.w3.org/hg/editing/raw-file/tip/editing.html
 */

rangy.createModule("TextRange", function(api, module) {
    api.requireModules( ["WrappedSelection"] );

    var UNDEF = "undefined";
    var CHARACTER = "character", WORD = "word";
    var dom = api.dom, util = api.util, DomPosition = dom.DomPosition;

    var log = log4javascript.getLogger("rangy.textrange");

    var spacesRegex = /^[ \t\f\r\n]+$/;
    var spacesMinusLineBreaksRegex = /^[ \t\f\r]+$/;
    /*
     var spacesPattern = "\u000b\u000c\u0020\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000";
     var newLinePattern = "\u000a-\u000d\u0085\u2028\u2029";
     var otherWhitespacePattern = "\u0009";
     */
    var allWhiteSpaceRegex = /^[\t-\r \u0085\u00A0\u1680\u180E\u2000-\u200B\u2028\u2029\u202F\u205F\u3000]+$/;

    var defaultLanguage = "en";

    var getComputedStyleProperty;
    if (typeof window.getComputedStyle != UNDEF) {
        getComputedStyleProperty = function(el, propName, win) {
            return (win || dom.getWindow(el)).getComputedStyle(el, null)[propName];
        };
    } else if (typeof document.documentElement.currentStyle != UNDEF) {
        getComputedStyleProperty = function(el, propName) {
            return el.currentStyle[propName];
        };
    } else {
        module.fail("No means of obtaining computed style properties found");
    }

    // "A block node is either an Element whose "display" property does not have
    // resolved value "inline" or "inline-block" or "inline-table" or "none", or a
    // Document, or a DocumentFragment."
    function isBlockNode(node) {
        return node
            && ((node.nodeType == 1 && !/^(inline(-block|-table)?|none)$/.test(getComputedDisplay(node)))
            || node.nodeType == 9 || node.nodeType == 11);
    }

    function getLastDescendantOrSelf(node) {
        var lastChild = node.lastChild;
        return lastChild ? getLastDescendantOrSelf(lastChild) : node;
    }

    function containsPositions(node) {
        return dom.isCharacterDataNode(node)
            || !/^(area|base|basefont|br|col|frame|hr|img|input|isindex|link|meta|param)$/i.test(node.nodeName);
    }

    function getAncestors(node) {
        var ancestors = [];
        while (node.parentNode) {
            ancestors.unshift(node.parentNode);
            node = node.parentNode;
        }
        return ancestors;
    }

    function getAncestorsAndSelf(node) {
        return getAncestors(node).concat([node]);
    }

    // Opera 11 puts HTML elements in the null namespace, it seems, and IE 7 has undefined namespaceURI
    function isHtmlNode(node) {
        var ns;
        return typeof (ns = node.namespaceURI) == UNDEF || (ns === null || ns == "http://www.w3.org/1999/xhtml");
    }

    function isHtmlElement(node, tagNames) {
        if (!node || node.nodeType != 1 || !isHtmlNode(node)) {
            return false;
        }
        switch (typeof tagNames) {
            case "string":
                return node.tagName.toLowerCase() == tagNames.toLowerCase();
            case "object":
                return new RegExp("^(" + tagNames.join("|S") + ")$", "i").test(node.tagName);
            default:
                return true;
        }
    }

    function nextNodeDescendants(node) {
        while (node && !node.nextSibling) {
            node = node.parentNode;
        }
        if (!node) {
            return null;
        }
        return node.nextSibling;
    }

    function nextNode(node, excludeChildren) {
        if (!excludeChildren && node.hasChildNodes()) {
            return node.firstChild;
        }
        return nextNodeDescendants(node);
    }

    function previousNode(node) {
        var previous = node.previousSibling;
        if (previous) {
            node = previous;
            while (node.hasChildNodes()) {
                node = node.lastChild;
            }
            return node;
        }
        var parent = node.parentNode;
        if (parent && parent.nodeType == 1) {
            return parent;
        }
        return null;
    }

    function isHidden(node) {
        var ancestors = getAncestorsAndSelf(node);
        for (var i = 0, len = ancestors.length; i < len; ++i) {
            if (ancestors[i].nodeType == 1 && getComputedDisplay(ancestors[i]) == "none") {
                return true;
            }
        }

        return false;
    }

    function isVisibilityHiddenTextNode(textNode) {
        var el;
        return textNode.nodeType == 3
            && (el = textNode.parentNode)
            && getComputedStyleProperty(el, "visibility") == "hidden";
    }

    // Adpated from Aryeh's code.
    // "A whitespace node is either a Text node whose data is the empty string; or
    // a Text node whose data consists only of one or more tabs (0x0009), line
    // feeds (0x000A), carriage returns (0x000D), and/or spaces (0x0020), and whose
    // parent is an Element whose resolved value for "white-space" is "normal" or
    // "nowrap"; or a Text node whose data consists only of one or more tabs
    // (0x0009), carriage returns (0x000D), and/or spaces (0x0020), and whose
    // parent is an Element whose resolved value for "white-space" is "pre-line"."
    function isWhitespaceNode(node) {
        if (!node || node.nodeType != 3) {
            return false;
        }
        var text = node.data;
        if (text == "") {
            return true;
        }
        var parent = node.parentNode;
        if (!parent || parent.nodeType != 1) {
            return false;
        }
        var computedWhiteSpace = getComputedStyleProperty(node.parentNode, "whiteSpace");

        return (/^[\t\n\r ]+$/.test(text) && /^(normal|nowrap)$/.test(computedWhiteSpace))
            || (/^[\t\r ]+$/.test(text) && computedWhiteSpace == "pre-line");
    }

    // Adpated from Aryeh's code.
    // "node is a collapsed whitespace node if the following algorithm returns
    // true:"
    function isCollapsedWhitespaceNode(node) {
        // "If node's data is the empty string, return true."
        if (node.data == "") {
            return true;
        }

        // "If node is not a whitespace node, return false."
        if (!isWhitespaceNode(node)) {
            return false;
        }

        // "Let ancestor be node's parent."
        var ancestor = node.parentNode;

        // "If ancestor is null, return true."
        if (!ancestor) {
            return true;
        }

        // "If the "display" property of some ancestor of node has resolved value "none", return true."
        if (isHidden(node)) {
            return true;
        }

        // "While ancestor is not a block node and its parent is not null, set
        // ancestor to its parent."
        while (!isBlockNode(ancestor) && ancestor.parentNode) {
            ancestor = ancestor.parentNode;
        }

        // "Let reference be node."
        var reference = node;

        // "While reference is a descendant of ancestor:"
        while (reference != ancestor) {
            // "Let reference be the node before it in tree order."
            reference = previousNode(reference);

            // "If reference is a block node or a br, return true."
            if (isBlockNode(reference) || isHtmlElement(reference, "br")) {
                return true;
            }

            // "If reference is a Text node that is not a whitespace node, or is an
            // img, break from this loop."
            if ((reference.nodeType == 3 && !isWhitespaceNode(reference)) || isHtmlElement(reference, "img")) {
                break;
            }
        }

        // "Let reference be node."
        reference = node;

        // "While reference is a descendant of ancestor:"
        var stop = nextNodeDescendants(ancestor);
        while (reference != stop) {
            // "Let reference be the node after it in tree order, or null if there
            // is no such node."
            reference = nextNode(reference);

            // "If reference is a block node or a br, return true."
            if (isBlockNode(reference) || isHtmlElement(reference, "br")) {
                return true;
            }

            // "If reference is a Text node that is not a whitespace node, or is an
            // img, break from this loop."
            if ((reference && reference.nodeType == 3 && !isWhitespaceNode(reference)) || isHtmlElement(reference, "img")) {
                break;
            }
        }

        // "Return false."
        return false;
    }

    // Test for old IE's incorrect display properties
    var tableCssDisplayBlock;
    (function() {
        var table = document.createElement("table");
        document.body.appendChild(table);
        tableCssDisplayBlock = (getComputedStyleProperty(table, "display") == "block");
        document.body.removeChild(table);
    })();

    api.features.tableCssDisplayBlock = tableCssDisplayBlock;

    var defaultDisplayValueForTag = {
        table: "table",
        caption: "table-caption",
        colgroup: "table-column-group",
        col: "table-column",
        thead: "table-header-group",
        tbody: "table-row-group",
        tfoot: "table-footer-group",
        tr: "table-row",
        td: "table-cell",
        th: "table-cell"
    };

    // Corrects IE's "block" value for table-related elements
    function getComputedDisplay(el, win) {
        var display = getComputedStyleProperty(el, "display", win);
        var tagName = el.tagName.toLowerCase();
        return (display == "block"
                && tableCssDisplayBlock
                && defaultDisplayValueForTag.hasOwnProperty(tagName))
            ? defaultDisplayValueForTag[tagName] : display;
    }

    function isCollapsedNode(node) {
        var type = node.nodeType;
        //log.debug("isCollapsedNode", isHidden(node), /^(script|style)$/i.test(node.nodeName), isCollapsedWhitespaceNode(node));
        return type == 7 /* PROCESSING_INSTRUCTION */
            || type == 8 /* COMMENT */
            || isHidden(node)
            || /^(script|style)$/i.test(node.nodeName)
            || isVisibilityHiddenTextNode(node)
            || isCollapsedWhitespaceNode(node);
    }

    function isIgnoredNode(node, win) {
        var type = node.nodeType;
        return type == 7 /* PROCESSING_INSTRUCTION */
            || type == 8 /* COMMENT */
            || (type == 1 && getComputedDisplay(node, win) == "none");
    }

    function hasInnerText(node) {
        if (!isCollapsedNode(node)) {
            if (node.nodeType == 3) {
                return true;
            } else {
                for (var child = node.firstChild; child; child = child.nextSibling) {
                    if (hasInnerText(child)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function getRangeStartPosition(range) {
        return new DomPosition(range.startContainer, range.startOffset);
    }

    function getRangeEndPosition(range) {
        return new DomPosition(range.endContainer, range.endOffset);
    }

    function TextPosition(character, position, isTrailingSpace, collapsible) {
        this.character = character;
        this.position = position;
        this.isTrailingSpace = isTrailingSpace;
        this.collapsible = collapsible;
    }

    TextPosition.prototype.toString = function() {
        return this.character;
    };

    function getTrailingSpace(el) {
        if (el.tagName.toLowerCase() == "br") {
            return "";
        } else {
            switch (getComputedDisplay(el)) {
                case "inline":
                    var child = el.lastChild;
                    while (child) {
                        if (!isIgnoredNode(child)) {
                            return (child.nodeType == 1) ? getTrailingSpace(child) : "";
                        }
                        child = child.previousSibling;
                    }
                    break;
                case "inline-block":
                case "inline-table":
                case "none":
                case "table-column":
                case "table-column-group":
                    break;
                case "table-cell":
                    return "\t";
                default:
                    return hasInnerText(el) ? "\n" : "";
            }
        }
        return "";
    }

    /*----------------------------------------------------------------------------------------------------------------*/

    /*
    Next and previous position moving functions that move between all possible positions in the document
     */
    function nextPosition(pos) {
        var node = pos.node, offset = pos.offset;
        if (!node) {
            return null;
        }
        var nextNode, nextOffset, child;
        if (offset == dom.getNodeLength(node)) {
            // Move onto the next node
            nextNode = node.parentNode;
            nextOffset = nextNode ? dom.getNodeIndex(node) + 1 : 0;
        } else {
            if (dom.isCharacterDataNode(node)) {
                nextNode = node;
                nextOffset = offset + 1;
            } else {
                child = node.childNodes[offset];
                // Go into the children next, if children there are
                if (containsPositions(child)) {
                    nextNode = child;
                    nextOffset = 0;
                } else {
                    nextNode = node;
                    nextOffset = offset + 1;
                }
            }
        }
        return nextNode ? new DomPosition(nextNode, nextOffset) : null;
    }

    function previousPosition(pos) {
        if (!pos) {
            return null;
        }
        var node = pos.node, offset = pos.offset;
        var previousNode, previousOffset, child;
        if (offset == 0) {
            previousNode = node.parentNode;
            previousOffset = previousNode ? dom.getNodeIndex(node) : 0;
        } else {
            if (dom.isCharacterDataNode(node)) {
                previousNode = node;
                previousOffset = offset - 1;
            } else {
                child = node.childNodes[offset - 1];
                // Go into the children next, if children there are
                if (containsPositions(child)) {
                    previousNode = child;
                    previousOffset = dom.getNodeLength(child);
                } else {
                    previousNode = node;
                    previousOffset = offset - 1;
                }
            }
        }
        return previousNode ? new DomPosition(previousNode, previousOffset) : null;
    }

    /*
    Next and previous position moving functions that filter

    - Whole whitespace nodes that do not affect rendering
    - Hidden (CSS visibility/display) elements
    - Script and style elements
    - collapsed whitespace characters
     */
    function nextVisiblePosition(pos) {
        var next = nextPosition(pos);
        if (!next) {
            return null;
        }
        var node = next.node;
        var newPos = next;
        if (isCollapsedNode(node)) {
            // We're skipping this node and all its descendants
            newPos = new DomPosition(node.parentNode, dom.getNodeIndex(node) + 1);
        }
        return newPos;
    }

    function previousVisiblePosition(pos) {
        var previous = previousPosition(pos);
        if (!previous) {
            return null;
        }
        var node = previous.node;
        var newPos = previous;
        if (isCollapsedNode(node)) {
            // We're skipping this node and all its descendants
            newPos = new DomPosition(node.parentNode, dom.getNodeIndex(node));
        }
        return newPos;
    }

    function createTransaction(win) {
/*
        var doc = win.document;
        var elementInfoCache = {};

        function getElementInfo(el) {
            var id = elementsHaveUniqueId ? el.uniqueID : el.id || "";
            var elementInfo, display;
            if (id && elementInfoCache.hasOwnProperty(id)) {
                elementInfo = elementInfoCache[id];
            }
            if (!elementInfo) {
                display = getComputedDisplay(el, win);
                elementInfo = {
                    display: display,
                    hidden: false
                };
                if (id) {
                    elementInfoCache[id] = elementInfo;
                }
            }

            return elementInfo;
        }



        return {
            win: win,

            isHidden: function(node) {
                var ancestors = getAncestorsAndSelf(node);
                for (var i = 0, len = ancestors.length; i < len; ++i) {
                    if (ancestors[i].nodeType == 1 && getComputedDisplay(ancestors[i]) == "none") {
                        return true;
                    }
                }

                return false;
            }

        }
*/
        return {};
    }

    function getTextNodeProperties(textNode) {
        log.debug("getTextNodeProperties for " + textNode.data);
        var spaceRegex = null, collapseSpaces = false;
        var cssWhitespace = getComputedStyleProperty(textNode.parentNode, "whiteSpace");
        var preLine = (cssWhitespace == "pre-line");
        if (preLine) {
            spaceRegex = spacesMinusLineBreaksRegex;
            collapseSpaces = true;
        } else if (cssWhitespace == "normal" || cssWhitespace == "nowrap") {
            spaceRegex = spacesRegex;
            collapseSpaces = true;
        }

        return {
            node: textNode,
            text: textNode.data,
            spaceRegex: spaceRegex,
            collapseSpaces: collapseSpaces,
            preLine: preLine
        };
    }

    function getPossibleCharacterAt(pos, transaction) {
        var node = pos.node, offset = pos.offset;
        var visibleChar = "", isTrailingSpace = false, collapsible = false;
        if (offset > 0) {
            if (node.nodeType == 3) {
                var text = node.data;
                var textChar = text.charAt(offset - 1);
                log.debug("Got char '" + textChar + "' in data '" + text + "'");
                var nodeInfo = transaction.nodeInfo;
                if (!nodeInfo || nodeInfo.node !== node) {
                    transaction.nodeInfo = nodeInfo = getTextNodeProperties(node);
                }
                var spaceRegex = nodeInfo.spaceRegex;
                if (nodeInfo.collapseSpaces) {
                    if (spaceRegex.test(textChar)) {
                        collapsible = true;
                        // "If the character at position is from set, append a single space (U+0020) to newdata and advance
                        // position until the character at position is not from set."

                        // We also need to check for the case where we're in a pre-line and we have a space preceding a
                        // line break, because such spaces are collapsed
                        if (offset > 1 && spaceRegex.test(text.charAt(offset - 2))) {
                            log.debug("Character is a collapsible space preceded by another collapsible space, skipping");
                        } else if (nodeInfo.preLine && text.charAt(offset) === "\n") {
                            log.debug("Character is a collapsible space which is followed by a line break in a pre-line element, skipping");
                        } else {
                            log.debug("Character is a collapsible space not preceded by another collapsible space, adding");
                            visibleChar = " ";
                        }
                    } else {
                        log.debug("Character is not a space, adding");
                        visibleChar = textChar;
                    }
                } else {
                    log.debug("Spaces are not collapsible, so adding");
                    visibleChar = textChar;
                }
            } else {
                var nodePassed = node.childNodes[offset - 1];
                if (nodePassed && nodePassed.nodeType == 1 && !isCollapsedNode(nodePassed)) {
                    if (nodePassed.tagName.toLowerCase() == "br") {
                        log.debug("Node is br");
                        visibleChar = "\n";
                    } else {
                        log.debug("Getting trailing space for node " + dom.inspectNode(nodePassed));
                        visibleChar = getTrailingSpace(nodePassed);
                        if (visibleChar) {
                            isTrailingSpace = collapsible = true;
                        }
                    }
                }
            }
        }
        return new TextPosition(visibleChar, pos, isTrailingSpace, collapsible);
    }

    function getPreviousPossibleCharacter(pos, transaction) {
        var previousPos = pos, previous;
        while ( (previousPos = previousVisiblePosition(previousPos)) ) {
            previous = getPossibleCharacterAt(previousPos, transaction);
            if (previous.character !== "") {
                return previous;
            }
        }
        return null;
    }

    function getNextPossibleCharacter(pos, transaction) {
        var nextPos = pos, next;
        while ( (nextPos = nextVisiblePosition(nextPos)) ) {
            next = getPossibleCharacterAt(nextPos, transaction);
            if (next.character !== "") {
                return next;
            }
        }
        return null;
    }

    function getCharacterAt(pos, transaction, precedingChars) {
        var possible = getPossibleCharacterAt(pos, transaction);
        var possibleChar = possible.character;
        var next, preceding;
        log.debug("*** getCharacterAt got possible char '" + possibleChar + "' at position " + pos);
        if (!possibleChar) {
            return possible;
        }
        if (spacesRegex.test(possibleChar)) {
            if (!precedingChars) {
                // Work backwards until we have a non-space character
                var previousPos = pos, previous, previousPossibleChar;
                precedingChars = [];
                while ( (previousPos = previousVisiblePosition(previousPos)) ) {
                    previous = getPossibleCharacterAt(previousPos, transaction);
                    previousPossibleChar = previous.character;
                    if (previousPossibleChar !== "") {
                        log.debug("Found preceding character '" + previousPossibleChar + "' at position " + previousPos);
                        precedingChars.unshift(previous);
                        if (previousPossibleChar != " " && previousPossibleChar != "\n") {
                            break;
                        }
                    }
                }
            }
            preceding = precedingChars[precedingChars.length - 1];

            log.info("possible.collapsible: " + possible.collapsible + ", trailing space: " + possible.isTrailingSpace + ", preceding: '" + preceding + "'");

            // Disallow a collapsible space that follows a trailing space or line break, or is the first character
            if (possibleChar === " " && possible.collapsible && (!preceding || preceding.isTrailingSpace || preceding.character === "\n")) {
                log.info("Preceding character is a trailing space or non-existent and current possible character is a collapsible space, so space is collapsed");
                possible.character = "";
            }

            // Disallow a collapsible space that is followed by a line break or is the last character
            else if (possible.collapsible && (!(next = getNextPossibleCharacter(pos, transaction)) || (next.character == "\n"))) {
                log.debug("Character is a space which is followed by a line break or nothing, collapsing");
                possible.character = "";
            }

            // Collapse a br element that is followed by a trailing space
            else if (possibleChar === "\n" && !possible.collapsible && (!(next = getNextPossibleCharacter(pos, transaction)) || next.isTrailingSpace)) {
                log.debug("Character is a br which is followed by a trailing space or nothing, collapsing");
                possible.character = "";
            }

            return possible;
        } else {
            return possible;
        }
    }

    function createCharacterIterator(startPos, backwards, endPos) {
        log.info("createCharacterIterator called backwards " + backwards + " and with endPos " + (endPos ? endPos.inspect() : ""));
        var transaction = createTransaction(dom.getWindow(startPos.node));

        // Adjust the end position to ensure that it is actually reached
        if (endPos) {
            if (backwards) {
                if (isCollapsedNode(endPos.node)) {
                    endPos = previousVisiblePosition(endPos);
                }
            } else {
                if (isCollapsedNode(endPos.node)) {
                    endPos = nextVisiblePosition(endPos);
                }
            }
        }
        log.info("endPos now " + (endPos ? endPos.inspect() : ""));

        var pos = startPos, finished = false;

        function next() {
            var textPos = null;
            if (!finished) {
                if (!backwards) {
                    pos = nextVisiblePosition(pos);
                }
                if (pos) {
                    textPos = getCharacterAt(pos, transaction);
                    //log.debug("pos is " + pos.inspect() + ", endPos is " + (endPos ? endPos.inspect() : null) + ", equal is " + pos.equals(endPos));
                    if (endPos && pos.equals(endPos)) {
                        finished = true;
                    }
                } else {
                    finished = true;
                }
                if (backwards) {
                    pos = previousVisiblePosition(pos);
                }
            }
            return textPos;
        }

        return {
            next: function() {
                var textPos;
                while ( (textPos = next()) ) {
                    if (textPos.character) {
                        return textPos;
                    }
                }
            },

            dispose: function() {
                startPos = endPos = transaction = null;
            }
        };
    }

    function createTextProvider(pos) {
        var forwardIterator = createCharacterIterator(pos, false);
        var backwardIterator = createCharacterIterator(pos, true);

        var chars = [];

        function toWordBoundary(forward, allowLeadingWhiteSpace) {
            var textPos, textChar, allowWhiteSpace = allowLeadingWhiteSpace;
            var newChars = [], it = forward ? forwardIterator : backwardIterator;
            while ( (textPos = it.next()) ) {
                textChar = textPos.character;
                if (allWhiteSpaceRegex.test(textChar)) {
                    if (!allowWhiteSpace) {
                        break;
                    }
                } else {
                    allowWhiteSpace = false;
                }
                newChars.push(textPos);
            }
            chars[forward ? "push" : "unshift"].apply(chars, newChars);

            return newChars;
        }

        return {
            chars: chars,

            getPrecedingWordChars: function() {
                return toWordBoundary(false, true);
            },

            getFollowingWordChars: function() {
                return toWordBoundary(true, true);
            },

            dispose: function() {
                chars = null;
                forwardIterator.dispose();
                backwardIterator.dispose();
            }
        };
    }

    var WORD_CHAR = "word", NON_WORD_CHAR = "non-word", WHITESPACE_CHAR = "white space";

    function defaultTokenizer(pos, options) {
        var textProvider = createTextProvider(pos);

        function tokenize(chars) {
            var word = chars.join("");
            var result, end, i;

            // Initially mark all characters as non-word or white space
            for (i = 0, end = chars.length; i < len; ++i) {
                chars[i].type = allWhiteSpaceRegex.test(chars[i]) ? WHITESPACE_CHAR : NON_WORD_CHAR;
            }

            // Match words and mark characters
            while ( (result = options.wordRegex.exec(word)) ) {
                for (i = result.index, end = i + result.length; i < end; ++i) {
                    chars[i].type = WORD_CHAR;
                }
            }
        }

        return {
            tokenizePreceding: function() {
                tokenize(textProvider.getPrecedingWordChars());
                return textProvider.chars;
            },

            tokenizeFollowing: function() {
                tokenize(textProvider.getFollowingWordChars());
                return textProvider.chars;
            },

            dispose: function() {
                textProvider.dispose();
            }
        };
    }

    var defaultWordOptions = {
        "en": {
            punctuationRegex: /[.,\-/#!$%^&*;:{}=_`~()'"]/,
            midWordPunctuationRegex: /'/,
            wordRegex: /[a-z0-9]+('[a-z0-9]+)?/g,
            includeTrailingSpace: false,
            tokenizer: defaultTokenizer
        }
    };

    function createWordOptions(options) {
        var lang, defaults;
        if (!options) {
            return defaultWordOptions[defaultLanguage];
        } else {
            lang = options.language || defaultLanguage;
            defaults = {};
            util.extend(defaults, defaultWordOptions[lang] || defaultWordOptions[defaultLanguage]);
            util.extend(defaults, options);
            return defaults;
        }
    }

    var defaultFindOptions = {
        caseSensitive: false,
        withinRange: null,
        wholeWordsOnly: false,
        wrap: false,
        backwards: false,
        wordOptions: null
    };

    /*
    Rewrite to have a separate tokenizing step. The tokenizer will have options or may be replaced by a custom tokenizer
    with customizable rules.

    Character types:

    - word
    - white space
    - punctuation
    - trailing punctuation (eg %)
    - leading punctuation (eg $)

    Tokenize into consecutive substrings of these types. A tokenizer may request more words but is still only obliged
    to tokenize the current word.

    Default English tokenizer will keep it simple. Suggest custom tokenizer using XRegExp and Unicode plugin for the
    adventurous. Maybe write a brief example?

     - consider all non-punctuation, non-whitespace chars as word chars
     - have a default set of allowed words containing punctuation (Mr. etc)
     - have a configurable list of all punctuation chars
     - have a configurable list of trailing punctuation chars
     - have a configurable list of mid-word punctuation chars allowed on their own, defaulting to '

    Maybe simpler. Maybe everything's a word character except white space and a set of non-word punctuation chars,
    which are set to be all punctuation minus ', which is like IE. So we're back to a configurable list of mid-word
    punctuation and a configurable list of punctuation characters.



    These can vary fully depending on context. A custom tokenizer function is passed a position and a character and may
    request more characters forwards or backwards, and/or the whole "word" (i.e. string of chars between white space
    chars or string terminators). Client code can use default or custom tokenizer, and default tokenizer has options:

     - punctuation regex
     - allowable mid-word punctuation regex
     - allowable trailing space regex (used in conjunction with include trailing punctuation option below)

    moveStart/end word options:

     - include trailing space (default false)
     - include trailing punctuation (default false)
     - skip punctuation between actual words (default true)

    expand options:

     - include trailing space (default false)
     - include trailing punctuation (default false)

     */

    function movePositionBy(pos, unit, count, options) {
        log.info("movePositionBy called " + count);
        var unitsMoved = 0, newPos = pos, textPos, absCount = Math.abs(count);
        if (count !== 0) {
            var backwards = (count < 0);
            var it = createCharacterIterator(pos, backwards);

            switch (unit) {
                case CHARACTER:
                    while ( (textPos = it.next()) && unitsMoved < absCount ) {
                        log.info("*** movePositionBy GOT CHAR " + textPos.character + "[" + textPos.character.charCodeAt(0) + "]");
                        ++unitsMoved;
                        newPos = textPos.position;
                    }
                    break;
                case WORD:
                    /*
                     - If first char is space, move on until non-space/punct encountered, then on until word end
                     - If first char is mid-word punct, check next and preceding chars. If both non-punct and non-space,
                       treat as word char, otherwise as punct
                     - If first char is other punct, move on until non-space/punct encountered, then on until word end
                     - Otherwise, move on until word end.
                     - Moving to word end: if char is space/non-mid-word-punct/end, word ends. If mid-word punct, check
                       preceding char and next char
                     */
                    var precedingChar = null, isWordChar, isTerminatorChar, isSpaceChar, isPunctuationChar;
                    var previousCharIsMidWordPunctuation = false;
                    var precedingIterator, precedingTextPos, ch, lastTextPosInWord;

                    while ( (textPos = it.next()) && unitsMoved < absCount ) {
                        ch = textPos.character;
                        isWordChar = isTerminatorChar = false;
                        isSpaceChar = spacesRegex.test(ch);
                        isPunctuationChar = options.punctuationRegex.test(ch);

                        if (isSpaceChar || isPunctuationChar) {
                            // If no word characters yet encountered, we just skip forward until we meet some.
                            // Otherwise, we're done, unless this was a mid-word punctuation character

                            if (!previousCharIsMidWordPunctuation && options.midWordPunctuationRegex.test(ch)) {
                                if (precedingChar === null) {
                                    // Check preceding character
                                    precedingIterator = createCharacterIterator(pos, !backwards);
                                    precedingTextPos = precedingIterator.next();
                                    precedingChar = precedingTextPos ? precedingTextPos.character : "";
                                    precedingIterator.dispose();
                                    if (precedingChar && !options.punctuationRegex.test(precedingChar) && !spacesRegex.test(precedingChar)) {
                                        previousCharIsMidWordPunctuation = true;
                                    } else {
                                        previousCharIsMidWordPunctuation = false;
                                        isTerminatorChar = true;
                                    }
                                }
                            } else if (!backwards && isPunctuationChar && lastTextPosInWord && options.includeTrailingPunctuation) {
                                isWordChar = true;
                            } else {
                                isTerminatorChar = true;
                                previousCharIsMidWordPunctuation = false;
                            }
                        } else {
                            previousCharIsMidWordPunctuation = false;
                            isWordChar = true;
                        }

                        log.info("**** TESTING CHAR " + ch + ". is word char: " + isWordChar + ", is terminator: " + isTerminatorChar);

                        if (isWordChar) {
                            lastTextPosInWord = textPos;
                        }

                        if (isTerminatorChar) {
                            if (lastTextPosInWord) {
                                newPos = (!backwards && options.includeTrailingSpace && ch == " ")
                                    ? textPos.position : lastTextPosInWord.position;

                                lastTextPosInWord = null;
                                ++unitsMoved;
                                log.info("**** FOUND TERMINATOR AFTER WORD. unitsMoved NOW " + unitsMoved);
                            }
                        }

                        precedingChar = ch;
                    }

                    // If we've run out of positions before the required number of words were navigated, check whether
                    // there was a last word and include it if so
                    if (lastTextPosInWord && unitsMoved < absCount) {
                        newPos = lastTextPosInWord.position;
                        ++unitsMoved;
                        log.info("**** FOUND EOF AFTER WORD. unitsMoved NOW " + unitsMoved);
                    }

                    break;
                default:
                    throw new Error("movePositionBy: unit '" + unit + "' not implemented");
            }
            if (backwards) {
                newPos = previousVisiblePosition(newPos);
                unitsMoved = -unitsMoved;
            }
            it.dispose();
        }

        return {
            position: newPos,
            unitsMoved: unitsMoved
        };
    }

    function createRangeCharacterIterator(range) {
        return createCharacterIterator(
            getRangeStartPosition(range),
            false,
            getRangeEndPosition(range)
        );
    }

    function getRangeCharacters(range) {
        log.info("getRangeCharacters called on range " + range.inspect());

        var chars = [], it = createRangeCharacterIterator(range), textPos;
        while ( (textPos = it.next()) ) {
            log.info("*** GOT CHAR " + textPos.character + "[" + textPos.character.charCodeAt(0) + "]");
            chars.push(textPos);
        }

        it.dispose();
        return chars;
    }

    function isWholeWord(startPos, endPos, wordOptions) {
        var range = api.createRange(startPos.node);
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
        var isWholeWord = !range.expand("word", wordOptions);
        range.detach();
        return isWholeWord;
    }

    function findTextFromPosition(initialPos, searchTerm, isRegex, searchScopeRange, options) {
        log.debug("findTextFromPosition called with search term " + searchTerm + ", initialPos " + initialPos.inspect() + " within range " + searchScopeRange.inspect());
        var backwards = options.backwards;
        var it = createCharacterIterator(
            initialPos,
            backwards,
            backwards ? getRangeStartPosition(searchScopeRange) : getRangeEndPosition(searchScopeRange)
        );
        var text = "", chars = [], textPos, currentChar, matchStartIndex, matchEndIndex;
        var result, insideRegexMatch;
        var returnValue = null;

        function handleMatch(startIndex, endIndex) {
            var startPos = previousVisiblePosition(chars[startIndex].position);
            var endPos = chars[endIndex - 1].position;
            var valid = (!options.wholeWordsOnly || isWholeWord(startPos, endPos, options.wordOptions));

            return {
                startPos: startPos,
                endPos: endPos,
                valid: valid
            };
        }

        while ( (textPos = it.next()) ) {
            currentChar = textPos.character;
            currentChar = textPos.character;
            if (!isRegex && !options.caseSensitive) {
                currentChar = currentChar.toLowerCase();
            }

            if (backwards) {
                chars.unshift(textPos);
                text = currentChar + text;
            } else {
                chars.push(textPos);
                text += currentChar;
            }

            if (isRegex) {
                result = searchTerm.exec(text);
                if (result) {
                    if (insideRegexMatch) {
                        // Check whether the match is now over
                        matchStartIndex = result.index;
                        matchEndIndex = matchStartIndex + result[0].length;
                        if ((!backwards && matchEndIndex < text.length) || (backwards && matchStartIndex > 0)) {
                            returnValue = handleMatch(matchStartIndex, matchEndIndex);
                            break;
                        }
                    } else {
                        insideRegexMatch = true;
                    }
                }
            } else if ( (matchStartIndex = text.indexOf(searchTerm)) != -1 ) {
                returnValue = handleMatch(matchStartIndex, matchStartIndex + searchTerm.length);
                break;
            }
        }

        // Check whether regex match extends to the end of the range
        if (insideRegexMatch) {
            returnValue = handleMatch(matchStartIndex, matchEndIndex);
        }
        it.dispose();

        return returnValue;
    }

    /*----------------------------------------------------------------------------------------------------------------*/

    // Extensions to the rangy.dom utility object

    util.extend(dom, {
        nextNode: nextNode,
        previousNode: previousNode,
        hasInnerText: hasInnerText
    });

    /*----------------------------------------------------------------------------------------------------------------*/

    // Extensions to the Rangy Range object

    util.extend(api.rangePrototype, {
        // Unit can be "character" or "word"
        moveStart: function(unit, count, options) {
            if (arguments.length == 1) {
                count = unit;
                unit = CHARACTER;
            }
            if (unit == WORD) {
                options = createWordOptions(options);
            }
            var moveResult = movePositionBy(getRangeStartPosition(this), unit, count, options);
            var newPos = moveResult.position;
            this.setStart(newPos.node, newPos.offset);
            return moveResult.unitsMoved;
        },

        // Unit can be "character" or "word"
        moveEnd: function(unit, count, options) {
            if (arguments.length == 1) {
                count = unit;
                unit = CHARACTER;
            }
            if (unit == WORD) {
                options = createWordOptions(options);
            }
            var moveResult = movePositionBy(getRangeEndPosition(this), unit, count, options);
            var newPos = moveResult.position;
            this.setEnd(newPos.node, newPos.offset);
            return moveResult.unitsMoved;
        },

        expand: function(unit, options) {
            var moved = false;
            if (!unit) {
                unit = CHARACTER;
            }
            if (unit == WORD) {
                options = createWordOptions(options);
                var startPos = getRangeStartPosition(this);
                var endPos = getRangeEndPosition(this);

                var moveStartResult = movePositionBy(startPos, WORD, 1, options);
                if (!moveStartResult.position.equals(startPos)) {
                    var newStartPos = movePositionBy(moveStartResult.position, WORD, -1, options).position;
                    this.setStart(newStartPos.node, newStartPos.offset);
                    log.info("**** MOVED START. Range now " + this.inspect(), startPos.inspect(), newStartPos.inspect());
                    moved = !newStartPos.equals(startPos);
                }
                if (this.collapsed) {
                    this.moveEnd(WORD, 1);
                    if (!this.collapsed) {
                        moved = true;
                    }
                } else {
                    var moveEndResult = movePositionBy(endPos, WORD, -1, options);
                    if (!moveEndResult.position.equals(endPos)) {
                        var newEndPos = movePositionBy(moveEndResult.position, WORD, 1, options).position;
                        this.setEnd(newEndPos.node, newEndPos.offset);
                        log.info("**** MOVED END. Range now " + this.inspect());
                        moved = moved || !newEndPos.equals(endPos);
                    }
                }

                return moved;
            } else {
                return this.moveEnd(CHARACTER, 1);
            }
        },

        text: function() {
            return this.collapsed ? "" : getRangeCharacters(this).join("");
        },

        selectCharacters: function(containerNode, startIndex, endIndex) {
            this.selectNodeContents(containerNode);
            this.collapse(true);
            this.moveStart(startIndex);
            this.collapse(true);
            this.moveEnd(endIndex - startIndex);
        },

        // Character indexes are relative to the start of node
        toCharacterRange: function(containerNode) {
            if (!containerNode) {
                containerNode = document.body;
            }
            var parent = containerNode.parentNode, nodeIndex = dom.getNodeIndex(containerNode);
            var rangeStartsBeforeNode = (dom.comparePoints(this.startContainer, this.endContainer, parent, nodeIndex) == -1);
            var rangeBetween = this.cloneRange();
            var startIndex, endIndex;
            if (rangeStartsBeforeNode) {
                rangeBetween.setStart(this.startContainer, this.startOffset);
                rangeBetween.setEnd(parent, nodeIndex);
                startIndex = -rangeBetween.text().length;
            } else {
                rangeBetween.setStart(parent, nodeIndex);
                rangeBetween.setEnd(this.startContainer, this.startOffset);
                startIndex = rangeBetween.text().length;
            }
            endIndex = startIndex + this.text().length;

            return {
                start: startIndex,
                end: endIndex
            };
        },

        findText: function(searchTermParam, optionsParam) {
            // Set up options
            var defaults = util.extend({}, defaultFindOptions);
            var options = optionsParam ? util.extend(defaults, optionsParam) : defaults;

            // Create word options if we're matching whole words only
            if (options.wholeWordsOnly) {
                options.wordOptions = createWordOptions(options.wordOptions);

                // We don't want trailing spaces
                options.wordOptions.includeTrailingSpace = false;
            }

            var backwards = options.backwards;

            // Create a range representing the search scope if none was provided
            var searchScopeRange = options.withinRange;
            if (!searchScopeRange) {
                searchScopeRange = api.createRange();
                searchScopeRange.selectNodeContents(this.getDocument());
            }

            // Examine and prepare the search term
            var searchTerm = searchTermParam, isRegex = false;
            if (typeof searchTerm == "string") {
                if (!options.caseSensitive) {
                    searchTerm = searchTerm.toLowerCase();
                }
            } else {
                isRegex = true;
            }

            var initialPos = backwards ? getRangeEndPosition(this) : getRangeStartPosition(this);

            // Adjust initial position if it lies outside the search scope
            var comparison = searchScopeRange.comparePoint(initialPos.node, initialPos.offset);
            if (comparison === -1) {
                initialPos = getRangeStartPosition(searchScopeRange);
            } else if (comparison === 1) {
                initialPos = getRangeEndPosition(searchScopeRange);
            }

            var pos = initialPos;
            var wrappedAround = false;

            // Try to find a match and ignore invalid ones
            var findResult;
            while (true) {
                findResult = findTextFromPosition(pos, searchTerm, isRegex, searchScopeRange, options);

                if (findResult) {
                    if (findResult.valid) {
                        this.setStart(findResult.startPos.node, findResult.startPos.offset);
                        this.setEnd(findResult.endPos.node, findResult.endPos.offset);
                        return true;
                    } else {
                        // We've found a match that is not a whole word, so we carry on searching from the point immediately
                        // after the match
                        pos = backwards ? findResult.startPos : findResult.endPos;
                    }
                } else if (options.wrap && !wrappedAround) {
                    // No result found but we're wrapping around and limiting the scope to the unsearched part of the range
                    searchScopeRange = searchScopeRange.cloneRange();
                    if (backwards) {
                        pos = getRangeEndPosition(searchScopeRange);
                        searchScopeRange.setStart(initialPos.node, initialPos.offset);
                    } else {
                        pos = getRangeStartPosition(searchScopeRange);
                        searchScopeRange.setEnd(initialPos.node, initialPos.offset);
                    }
                    log.debug("Wrapping search. New search range is " + searchScopeRange.inspect());
                    wrappedAround = true;
                } else {
                    // Nothing found and we can't wrap around, so we're done
                    return false;
                }
            }
        },

        pasteHtml: function(html) {
            this.deleteContents();
            var frag = this.createContextualFragment(html);
            this.insertNode(frag);
        }
    });

    /*----------------------------------------------------------------------------------------------------------------*/

    // Extensions to the Rangy Selection object

    util.extend(api.selectionPrototype, {
        expand: function(unit, options) {
            var ranges = this.getAllRanges(), rangeCount = ranges.length;
            var backwards = this.isBackwards();

            for (var i = 0, len = ranges.length; i < len; ++i) {
                ranges[i].expand(unit, options);
            }

            this.removeAllRanges();
            if (backwards && rangeCount == 1) {
                this.addRange(ranges[0], true);
            } else {
                this.setRanges(ranges);
            }
        },

        selectCharacters: function(containerNode, startIndex, endIndex, backwards) {
            var range = api.createRange(containerNode);
            range.selectCharacters(containerNode, startIndex, endIndex);
            this.setSingleRange(range, backwards);
        },

        saveCharacterRanges: function(containerNode) {
            var ranges = this.getAllRanges(), rangeCount = ranges.length;
            var characterRanges = [];

            var backwards = rangeCount == 1 && this.isBackwards();

            for (var i = 0, len = ranges.length; i < len; ++i) {
                characterRanges[i] = {
                    range: ranges[i].toCharacterRange(containerNode),
                    backwards: backwards
                }
            }

            return characterRanges;
        },

        restoreCharacterRanges: function(containerNode, characterRanges) {
            this.removeAllRanges();
            for (var i = 0, len = characterRanges.length, range, characterRange; i < len; ++i) {
                characterRange = characterRanges[i];
                range = api.createRange(containerNode);
                range.selectCharacters(containerNode, characterRange.range.start, characterRange.range.end);
                this.addRange(range, characterRange.backwards);
            }
        }
    });

    /*----------------------------------------------------------------------------------------------------------------*/

    // Extensions to the core rangy object

    api.innerText = function(el) {
        var range = api.createRange(el);
        range.selectNodeContents(el);
        var text = range.text();
        range.detach();
        return text;
    };

    /*----------------------------------------------------------------------------------------------------------------*/

    api.textRange = {
        isBlockNode: isBlockNode,
        isCollapsedWhitespaceNode: isCollapsedWhitespaceNode,
        nextPosition: nextPosition,
        previousPosition: previousPosition,
        nextVisiblePosition: nextVisiblePosition,
        previousVisiblePosition: previousVisiblePosition
    };

});

import _ from 'lodash';
import React, {Component} from 'react';
import {inject, observer} from "mobx-react";
import classnames from "classnames";
import { Link } from "react-router-dom";
import { ListGroup, ListGroupItem } from 'reactstrap';
import { Button, ButtonGroup } from 'reactstrap';
import { UncontrolledButtonDropdown, DropdownToggle, DropdownMenu, DropdownItem } from 'reactstrap';

import LoggedInLayout from "../components/LoggedInLayout";
import RedditShareDialog from "../components/RedditShareDialog";
import ConfirmSocialDialog from "../components/ConfirmSocialDialog";
import BaseItemsPage from "./BaseItemsPage";
import urls from "../config/urls";
import * as api from '../api';

@inject('postsStore')
@observer
class Posts extends BaseItemsPage {
  componentDidMount() {
    this.props.postsStore.loadPage(0);
    this.props.postsStore.loadSocialAvailability();
  }

  render() {
    return (
      <div>
        {this._renderContent({
          title: 'Posts',
          newItem: 'New post',
          noItems: 'No posts created yet',
          urlPart: this._getUrlPart()
        }, this.props.postsStore)}
        {this._renderDialog()}
      </div>
    )
  }

  _renderDialog() {
    switch (this.props.postsStore.socialDialog) {
      case 'twitter':
      case 'linkedin':
      case 'medium':
        return <ConfirmSocialDialog postsStore={this.props.postsStore} />;
      case 'reddit':
        return <RedditShareDialog postsStore={this.props.postsStore} />;
      default:
        return false;
    }
  }

  _renderLineItemExtra(item) {
    const { socialAvailability } = this.props.postsStore;
    const renderItem = (title, key) => socialAvailability && (
      <DropdownItem
        disabled={socialAvailability[key] === 'not_configured'}
        onClick={() => {
          if (socialAvailability[key] === 'ready') {
            this.props.postsStore.setSocialDialog(key, item);
          }
          else {
            api.redirectToSocialConnect(key);
          }
        }}>
        {title} {socialAvailability[key] === 'not_configured' ? '- not configured' : (
          socialAvailability[key] === 'not_connected' ? '- not connected' : false
        )}
      </DropdownItem>
    );

    return (
      <UncontrolledButtonDropdown style={{ marginRight: 10 }}>
        <DropdownToggle caret>
          <i style={{ marginLeft: 5 }} className='fa fa-share-alt' />
        </DropdownToggle>
        <DropdownMenu>
          {! socialAvailability && <DropdownItem header>Loading...</DropdownItem>}
          {renderItem('Twitter', 'twitter')}
          {renderItem('Linkedin', 'linkedin')}
          {renderItem('Reddit', 'reddit')}
        </DropdownMenu>
      </UncontrolledButtonDropdown>
    )
  }

  _getUrlPart() {
    return 'post';
  }

  _getStore() {
    return this.props.postsStore;
  }

  async _onDeleteItem() {
    try {
      this.props.postsStore.setItemDeleting(true);
      await api.deletePost(this.props.postsStore.deleteItemId);
      this.props.postsStore.loadPage(0);
      this.props.postsStore.setDeleteItemId(null);
    }
    catch (err) {
      console.log(err);
    }
    finally {
      this.props.postsStore.setItemDeleting(false);
    }
  }
}

export default Posts;
